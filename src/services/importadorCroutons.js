const fs = require('fs');
const db = require('../db/database');

// Nombres de columna aceptados (todo en minúscula, sin acentos) para cada
// campo — el archivo puede venir de proveedores distintos con encabezados
// distintos, así que probamos varias variantes en vez de exigir una sola.
const COLUMNAS = {
  producto:   ['producto', 'nombre', 'descripcion', 'description', 'articulo'],
  cantidad:   ['cantidad', 'cant', 'qty'],
  unidad:     ['unidad', 'um', 'unit'],
  proveedor:  ['proveedor', 'provider', 'supplier'],
  lote:       ['lote', 'lote_proveedor', 'batch'],
  vencimiento: ['vencimiento', 'fecha_vencimiento', 'fechavencimiento', 'vto', 'expiry', 'expiration', 'best before', 'vence'],
};

function quitarAcentos(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizarEncabezado(s) {
  return quitarAcentos(s || '').trim().toLowerCase();
}

// Detecta si el archivo usa "," o ";" como separador mirando la primera línea no vacía
function detectarSeparador(primeraLinea) {
  const cantComas = (primeraLinea.match(/,/g) || []).length;
  const cantPuntoYComa = (primeraLinea.match(/;/g) || []).length;
  return cantPuntoYComa > cantComas ? ';' : ',';
}

function parsearLinea(linea, separador) {
  return linea.split(separador).map(c => c.trim().replace(/^"|"$/g, ''));
}

// "5,5" -> 5.5   |   "5.5" -> 5.5   |   "" -> 0
function parsearCantidad(valorCrudo) {
  if (!valorCrudo) return 0;
  const limpio = String(valorCrudo).replace(',', '.').trim();
  const num = parseFloat(limpio);
  return isNaN(num) ? 0 : num;
}

// Acepta "2026-11-20", "20/11/2026" o "20-11-2026" -> "YYYY-MM-DD"
function parsearFecha(valorCrudo) {
  if (!valorCrudo) return null;
  const v = String(valorCrudo).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

  const match = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) {
    const [, d, m, y] = match;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return null;
}

/**
 * Parsea un CSV/TSV de mercadería de croutons y devuelve un array de lotes
 * normalizados, listos para importar. Tolera encabezados en español o
 * inglés y separador por coma o punto y coma.
 */
function parsearCsvCroutons(rutaArchivo) {
  const contenido = fs.readFileSync(rutaArchivo, 'utf8');
  const lineas = contenido.split(/\r?\n/).filter(l => l.trim());
  if (lineas.length === 0) {
    throw new Error('El archivo está vacío.');
  }

  const separador = detectarSeparador(lineas[0]);
  const encabezados = parsearLinea(lineas[0], separador).map(normalizarEncabezado);

  function buscarColumna(variantes) {
    for (const variante of variantes) {
      const idx = encabezados.indexOf(variante);
      if (idx !== -1) return idx;
    }
    return -1;
  }

  const idx = {
    producto: buscarColumna(COLUMNAS.producto),
    cantidad: buscarColumna(COLUMNAS.cantidad),
    unidad: buscarColumna(COLUMNAS.unidad),
    proveedor: buscarColumna(COLUMNAS.proveedor),
    lote: buscarColumna(COLUMNAS.lote),
    vencimiento: buscarColumna(COLUMNAS.vencimiento),
  };

  if (idx.producto === -1 || idx.vencimiento === -1) {
    throw new Error('El archivo tiene que tener al menos una columna de producto y una de vencimiento (ej: "Producto" y "Vencimiento").');
  }

  const productos = [];
  for (let i = 1; i < lineas.length; i++) {
    const campos = parsearLinea(lineas[i], separador);
    const producto = (campos[idx.producto] || '').trim();
    const fechaVencimiento = parsearFecha(campos[idx.vencimiento]);

    productos.push({
      producto,
      cantidad: idx.cantidad !== -1 ? parsearCantidad(campos[idx.cantidad]) : 0,
      unidad: idx.unidad !== -1 ? (campos[idx.unidad] || '').trim() || 'kg' : 'kg',
      proveedor: idx.proveedor !== -1 ? (campos[idx.proveedor] || '').trim() : '',
      lote_proveedor: idx.lote !== -1 ? (campos[idx.lote] || '').trim() : '',
      fecha_vencimiento: fechaVencimiento,
      valido: !!producto && !!fechaVencimiento,
    });
  }

  return productos.filter(p => p.producto || p.fecha_vencimiento); // descarta filas totalmente vacías
}

/**
 * Importa un array de lotes ya parseados. Cada fila válida (con producto y
 * fecha de vencimiento) se inserta como un lote nuevo — a diferencia de los
 * insumos de Costos, acá no se hace upsert por código: cada entrada de
 * mercadería es su propio lote con su propio vencimiento.
 */
async function importarLotesCroutons(productos, proveedorPorDefecto, usuarioId) {
  const resumen = {
    cargados: 0,
    sinProducto: 0,
    sinVencimiento: 0,
  };

  for (const p of productos) {
    if (!p.producto) {
      resumen.sinProducto++;
      continue;
    }
    if (!p.fecha_vencimiento) {
      resumen.sinVencimiento++;
      continue;
    }

    await db.run2(
      `INSERT INTO croutons_lotes (producto, cantidad, unidad, proveedor, lote_proveedor, fecha_vencimiento, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        p.producto,
        p.cantidad || 0,
        p.unidad || 'kg',
        p.proveedor || proveedorPorDefecto || '',
        p.lote_proveedor || '',
        p.fecha_vencimiento,
        usuarioId || null,
      ]
    );
    resumen.cargados++;
  }

  return resumen;
}

module.exports = { parsearCsvCroutons, importarLotesCroutons };
