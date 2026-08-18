const fs = require('fs');
const db = require('../db/database');

// Mapeo de unidades del sistema de compras -> unidades que usa el portal
const MAPA_UNIDADES = {
  'KG': 'kg',
  'UN': 'unidad',
  'CJ': 'caja',
  'BT': 'botella',
  'LT': 'lt',
  'GR': 'g',
  'ML': 'ml',
  'DC': 'docena',
};

function mapearUnidad(unidadCruda) {
  const u = (unidadCruda || '').trim().toUpperCase();
  return MAPA_UNIDADES[u] || u.toLowerCase() || 'unidad';
}

// "$12.900,00" -> 12900.00   |   "$0,00" -> 0
function parsearPrecio(precioCrudo) {
  if (!precioCrudo) return 0;
  const limpio = String(precioCrudo)
    .replace(/\$/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
    .trim();
  const num = parseFloat(limpio);
  return isNaN(num) ? 0 : num;
}

// "P30601909290-FRIGORIFICO LANUS SRL" -> "FRIGORIFICO LANUS SRL"
function limpiarProveedor(proveedorCrudo) {
  if (!proveedorCrudo) return '';
  const texto = String(proveedorCrudo).trim();
  const match = texto.match(/^P?\d{6,}-(.+)$/);
  return match ? match[1].trim() : texto;
}

// Encuentra la fila de encabezado real dentro del archivo (el export trae varias
// filas de metadata arriba: nombre de la empresa, fechas, departamento, etc.)
function encontrarEncabezado(lineas) {
  for (let i = 0; i < lineas.length; i++) {
    if (lineas[i].includes('Code') && lineas[i].includes('Description') && lineas[i].includes('Precio')) {
      return i;
    }
  }
  return -1;
}

function parsearLinea(linea) {
  // Los datos no traen ; embebidos dentro de un campo, así que un split simple alcanza
  return linea.split(';').map(c => c.trim());
}

/**
 * Parsea el CSV de compras (formato "South Convention Center / BIQA") y devuelve
 * un array de productos normalizados, listos para importar.
 */
function parsearCsvInsumos(rutaArchivo) {
  // El archivo viene en ISO-8859-1 ("latin1" en Node es el mismo charset)
  const contenido = fs.readFileSync(rutaArchivo, 'latin1');
  const lineas = contenido.split(/\r?\n/);

  const idxHeader = encontrarEncabezado(lineas);
  if (idxHeader === -1) {
    throw new Error('No se encontró la fila de encabezado (Code / Description / Precio#) en el archivo.');
  }

  const columnas = parsearLinea(lineas[idxHeader]);
  const idx = {
    codigo: columnas.findIndex(c => c === 'Code'),
    nombre: columnas.findIndex(c => c === 'Description'),
    unidad: columnas.findIndex(c => c === 'Base Unit'),
    proveedor: columnas.findIndex(c => c === 'Proveedor#'),
    precio: columnas.findIndex(c => c === 'Precio#'),
  };

  const faltantes = Object.entries(idx).filter(([, v]) => v === -1).map(([k]) => k);
  if (faltantes.length) {
    throw new Error('No se encontraron estas columnas esperadas en el archivo: ' + faltantes.join(', '));
  }

  const productos = [];
  for (let i = idxHeader + 1; i < lineas.length; i++) {
    const linea = lineas[i];
    if (!linea || !linea.trim()) continue;

    const campos = parsearLinea(linea);
    const codigo = (campos[idx.codigo] || '').trim();
    if (!codigo) continue; // fila sin código, no es un producto válido

    productos.push({
      codigo,
      nombre: (campos[idx.nombre] || '').trim(),
      unidad: mapearUnidad(campos[idx.unidad]),
      proveedor: limpiarProveedor(campos[idx.proveedor]),
      precio_unitario: parsearPrecio(campos[idx.precio]),
    });
  }

  return productos;
}

/**
 * Importa un array de productos ya parseados: upsert por código.
 * - Código nuevo -> INSERT
 * - Código existente con precio distinto -> UPDATE + historial_precios (origen='importacion_csv')
 * - Código existente con mismo precio -> no se toca
 */
async function importarInsumos(productos, categoria) {
  const resumen = {
    nuevos: 0,
    actualizados: 0,
    sinCambios: 0,
    sinPrecio: 0,
    negativosRechazados: 0, // filas con precio negativo (ej: nota de crédito colada en el archivo) — se ignoran
    menoresIgnorados: 0, // precio nuevo menor al actual: se mantiene el más alto, no se aplica la baja
    cambiosDePrecios: [], // {codigo, nombre, precio_anterior, precio_nuevo}
  };

  for (const p of productos) {
    // Precio negativo: no es un precio de compra válido (suele ser una bonificación
    // o una nota de crédito mezclada en el archivo). No se crea ni se actualiza nada.
    if (p.precio_unitario < 0) {
      resumen.negativosRechazados++;
      continue;
    }
    if (p.precio_unitario === 0) resumen.sinPrecio++;

    const existente = await db.get2('SELECT * FROM insumos WHERE codigo=$1', [p.codigo]);

    if (!existente) {
      await db.run2(
        `INSERT INTO insumos (nombre, categoria, unidad, precio_unitario, stock_actual, proveedor, codigo)
         VALUES ($1,$2,$3,$4,0,$5,$6)`,
        [p.nombre, categoria, p.unidad, p.precio_unitario, p.proveedor, p.codigo]
      );
      resumen.nuevos++;
      continue;
    }

    const precioAnterior = parseFloat(existente.precio_unitario) || 0;

    // Regla: el precio de costo nunca baja solo por una importación — se mantiene
    // el más alto conocido, como margen de seguridad para el costeo de los platos.
    if (p.precio_unitario < precioAnterior) {
      resumen.menoresIgnorados++;
      continue;
    }

    if (Math.abs(precioAnterior - p.precio_unitario) > 0.001) {
      await db.run2(
        `UPDATE insumos SET precio_unitario=$1, proveedor=$2, actualizado_en=NOW() WHERE codigo=$3`,
        [p.precio_unitario, p.proveedor, p.codigo]
      );
      await db.run2(
        `INSERT INTO historial_precios (insumo_id, precio_anterior, precio_nuevo, origen)
         VALUES ($1,$2,$3,'importacion_csv')`,
        [existente.id, precioAnterior, p.precio_unitario]
      );
      resumen.actualizados++;
      resumen.cambiosDePrecios.push({
        insumo_id: existente.id,
        codigo: p.codigo,
        nombre: p.nombre,
        precio_anterior: precioAnterior,
        precio_nuevo: p.precio_unitario,
      });
    } else {
      resumen.sinCambios++;
    }
  }

  return resumen;
}

module.exports = { parsearCsvInsumos, importarInsumos };
