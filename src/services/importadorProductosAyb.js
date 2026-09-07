// Importación masiva de productos para Inventario AYB.
//
// Pensado para cuando hay que cargar "un montón" de productos de una — el
// usuario sube un Excel o CSV que YA tiene armado (de compras, de un cierre
// de inventario, del proveedor, o hecho a mano), no uno con un formato fijo.
// Por eso la detección de columnas es flexible (español e inglés: "Producto"
// o "Description", "Stock actual" o "Physical Balance", etc.) y se leen
// TODAS las hojas del archivo, no solo la primera — un cierre de inventario
// típico trae una hoja por ubicación/sector.
//
// Regla de import: por código de producto si el archivo lo trae (más
// confiable), si no por nombre (sin acentos/mayúsculas/espacios). Si el
// producto YA existe en el sistema, no se toca — así nunca se pisa un stock
// o un mínimo que alguien ya haya cargado o contado a mano. Solo se crean
// los que faltan.
const ExcelJS = require('exceljs');

// Cada clave del catálogo con las variantes de encabezado que reconocemos
// (todo comparado ya sin acentos, en minúscula y sin espacios extra).
const ALIAS_COLUMNAS = {
  nombre: ['producto', 'nombre', 'articulo', 'descripcion', 'description', 'item', 'detalle'],
  categoria: ['categoria', 'rubro', 'familia', 'ubicacion', 'location', 'sector'],
  unidad: ['unidad', 'um', 'unidaddefault', 'unidadmedida', 'unit'],
  stock_minimo: ['stockminimo', 'minimo', 'stockmin', 'minstock'],
  stock_actual: ['stockactual', 'stock', 'cantidad', 'saldofisico', 'physicalbalance', 'balance', 'existencia'],
  codigo_barras: ['codigodebarras', 'codigobarras', 'codbarras', 'ean', 'codigo', 'itemcode', 'code'],
};

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca acentos
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ''); // saca espacios, guiones, etc.
}

// Convierte un valor de celda (puede venir como número, texto con "$"/coma
// decimal, fórmula ya resuelta, etc.) a número, o null si no es numérico.
function aNumero(valorCrudo) {
  if (valorCrudo === null || valorCrudo === undefined || valorCrudo === '') return null;
  if (typeof valorCrudo === 'number') return valorCrudo;
  if (typeof valorCrudo === 'object' && valorCrudo.result !== undefined) return aNumero(valorCrudo.result); // celda con fórmula
  const limpio = String(valorCrudo).replace(/\$/g, '').replace(/\./g, '').replace(',', '.').trim();
  const num = parseFloat(limpio);
  return isNaN(num) ? null : num;
}

function detectarColumnas(encabezados) {
  const mapa = {}; // clave del catálogo -> índice de columna
  encabezados.forEach((valor, idx) => {
    const norm = normalizar(valor);
    if (!norm) return;
    for (const [clave, alias] of Object.entries(ALIAS_COLUMNAS)) {
      if (mapa[clave] !== undefined) continue; // ya encontrada, no pisar con una columna repetida
      if (alias.includes(norm)) mapa[clave] = idx;
    }
  });
  return mapa;
}

// Busca la fila de encabezado real dentro de las primeras filas de una hoja
// (algunos exports traen una fila vacía o un título arriba de la tabla).
function encontrarEncabezadoHoja(hoja) {
  const maxFilasABuscar = Math.min(5, hoja.rowCount);
  for (let i = 1; i <= maxFilasABuscar; i++) {
    const valores = hoja.getRow(i).values.slice(1);
    const columnas = detectarColumnas(valores);
    if (columnas.nombre !== undefined) return { fila: i, columnas };
  }
  return null;
}

/**
 * Lee un .xlsx/.xls/.csv y devuelve las filas normalizadas de TODAS las
 * hojas reconocidas: [{nombre, categoria, unidad, stock_minimo, stock_actual, codigo_barras}, ...]
 * más la lista de hojas que se saltearon por no tener una columna de nombre
 * reconocible (ej. una hoja de costeo que no es un listado de productos).
 * Lanza error solo si NINGUNA hoja tiene una columna de nombre reconocible.
 */
async function parsearArchivoProductosAyb(rutaArchivo, nombreOriginal) {
  const workbook = new ExcelJS.Workbook();
  const esCsv = /\.csv$/i.test(nombreOriginal || rutaArchivo);

  if (esCsv) {
    await workbook.csv.readFile(rutaArchivo);
  } else {
    await workbook.xlsx.readFile(rutaArchivo);
  }

  const filas = [];
  const hojasOmitidas = [];

  for (const hoja of workbook.worksheets) {
    if (hoja.rowCount < 2) continue; // hoja vacía, se ignora sin avisar

    const encabezado = encontrarEncabezadoHoja(hoja);
    if (!encabezado) {
      hojasOmitidas.push(hoja.name);
      continue;
    }

    const { fila: filaEncabezado, columnas } = encabezado;

    hoja.eachRow((row, numFila) => {
      if (numFila <= filaEncabezado) return; // encabezado (y lo que haya arriba)
      const valores = row.values.slice(1);
      const celda = (idx) => (idx === undefined ? '' : String(valores[idx] ?? '').trim());

      const nombre = celda(columnas.nombre);
      if (!nombre) return; // fila vacía dentro de la hoja (frecuente al final de cada bloque) — se ignora sin contar como error

      filas.push({
        nombre,
        categoria: celda(columnas.categoria) || hoja.name || null,
        unidad: celda(columnas.unidad) || 'unidad',
        stock_minimo: aNumero(valores[columnas.stock_minimo]),
        stock_actual: aNumero(valores[columnas.stock_actual]),
        codigo_barras: celda(columnas.codigo_barras) || null,
      });
    });
  }

  if (filas.length === 0) {
    throw new Error('No se encontró una columna con el nombre del producto en ninguna hoja del archivo (probá con un encabezado como "Producto", "Nombre" o "Description").');
  }

  return { filas, hojasOmitidas };
}

/**
 * Importa las filas ya parseadas. No pisa productos existentes — así una
 * importación repetida o parcial nunca borra o cambia un stock/mínimo que ya
 * se haya cargado o contado a mano. El match contra lo existente es por
 * código de barras (si el archivo y el producto ya cargado lo tienen) o si
 * no por nombre, sin acentos/mayúsculas/espacios.
 *
 * Si el mismo producto aparece en más de una hoja del archivo (ej. el mismo
 * insumo contado en dos ubicaciones distintas de un cierre de inventario),
 * se suma su stock en vez de descartarlo como duplicado — total real de la
 * empresa, ya que el sistema no separa el stock por ubicación.
 */
async function importarProductosAyb(filas, db) {
  const resumen = {
    nuevos: 0,
    yaExistian: 0,
    combinadosDeVariasHojas: 0, // mismo producto en más de una ubicación del archivo — se sumó su stock
    sinNombre: 0,
    totalProcesados: filas.length,
  };

  const existentes = await db.all2('SELECT nombre, codigo_barras FROM productos_ayb');
  const nombresExistentes = new Set(existentes.map(p => normalizar(p.nombre)));
  const codigosExistentes = new Set(existentes.filter(p => p.codigo_barras).map(p => normalizar(p.codigo_barras)));

  // clave (código si hay, si no nombre normalizado) -> fila acumulada del archivo
  const porClave = new Map();

  for (const fila of filas) {
    if (!fila.nombre) { resumen.sinNombre++; continue; }

    const clave = fila.codigo_barras ? 'cod:' + normalizar(fila.codigo_barras) : 'nom:' + normalizar(fila.nombre);

    if (porClave.has(clave)) {
      const acumulada = porClave.get(clave);
      acumulada.stock_actual = (acumulada.stock_actual || 0) + (fila.stock_actual || 0);
      if (acumulada.stock_minimo == null) acumulada.stock_minimo = fila.stock_minimo;
      resumen.combinadosDeVariasHojas++;
    } else {
      porClave.set(clave, { ...fila });
    }
  }

  for (const fila of porClave.values()) {
    const claveNombre = normalizar(fila.nombre);
    const claveCodigo = fila.codigo_barras ? normalizar(fila.codigo_barras) : null;
    const yaExiste = nombresExistentes.has(claveNombre) || (claveCodigo && codigosExistentes.has(claveCodigo));

    if (yaExiste) {
      resumen.yaExistian++;
      continue;
    }

    await db.run2(
      `INSERT INTO productos_ayb (nombre, categoria, unidad_default, stock_minimo, stock_actual, codigo_barras)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [fila.nombre, fila.categoria, fila.unidad, fila.stock_minimo, fila.stock_actual || 0, fila.codigo_barras]
    );
    nombresExistentes.add(claveNombre);
    if (claveCodigo) codigosExistentes.add(claveCodigo);
    resumen.nuevos++;
  }

  return resumen;
}

/** Genera el .xlsx de plantilla que se ofrece para descargar antes de importar. */
async function generarPlantillaProductosAyb() {
  const wb = new ExcelJS.Workbook();
  const hoja = wb.addWorksheet('Productos AYB');
  hoja.columns = [
    { header: 'Producto', key: 'producto', width: 32 },
    { header: 'Categoría', key: 'categoria', width: 18 },
    { header: 'Unidad', key: 'unidad', width: 12 },
    { header: 'Stock actual', key: 'stock_actual', width: 14 },
    { header: 'Stock mínimo', key: 'stock_minimo', width: 14 },
    { header: 'Código de barras', key: 'codigo_barras', width: 18 },
  ];
  hoja.getRow(1).font = { bold: true };
  hoja.addRow({ producto: 'Vodka Absolut 750ml', categoria: 'Destilados', unidad: 'botella', stock_actual: 12, stock_minimo: 3, codigo_barras: '' });
  hoja.addRow({ producto: 'Coca Cola 1.5L', categoria: 'Gaseosas', unidad: 'botella', stock_actual: 24, stock_minimo: 6, codigo_barras: '' });
  return wb;
}

module.exports = { parsearArchivoProductosAyb, importarProductosAyb, generarPlantillaProductosAyb };
