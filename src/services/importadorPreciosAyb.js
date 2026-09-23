// Actualización masiva de precios para Inventario AYB.
//
// Mismo espíritu que importadorProductosAyb.js (detección de columnas
// flexible, español e inglés, lee todas las hojas), pero para ACTUALIZAR
// el precio de productos que YA existen, no para crear productos nuevos.
//
// El precio se guarda en el sistema en pesos POR ML/UNIDAD DE RECETA (no
// por botella entera) — así lo usa Costos para calcular el costo de cada
// trago: cantidad × precio_unitario. Por eso, si el archivo trae el precio
// por botella/unidad de compra, hay que convertirlo dividiendo por el
// tamaño. Dos formas de resolver el tamaño, en este orden:
//   1) Si el archivo tiene una columna de tamaño (ej. "Bottle Size ml"),
//      se usa esa.
//   2) Si no, se intenta leer del propio nombre del producto (ej.
//      "x750cc", "X 1L", "750 ML").
//   3) Si tampoco, se usa el tamaño que haya elegido quien sube el archivo
//      (modoPrecio: 'directo' = el precio ya viene por ml, no convertir;
//      'botella' = asumir 750ml salvo que se haya podido leer otra cosa).
//
// El matcheo contra el catálogo es por código de barras exacto si el
// archivo lo trae (más confiable, cero ambigüedad — mismo criterio que la
// importación de productos nuevos), y si no por nombre, con un comparador
// de similitud por palabras en común. A diferencia del comparador que usa
// el reconocimiento de botellas por foto (pensado para comparar dos
// nombres de largo parecido), acá el nombre buscado suele ser más CORTO
// que el nombre real del catálogo (ej. archivo dice "Campari", catálogo
// tiene "CAMPARI x750cc") — por eso el puntaje mide qué fracción de las
// palabras del nombre buscado aparece en el candidato, no al revés. Y para
// evitar falsos positivos con nombres de un solo término genérico (ej.
// "Italia", "Francia" al final de muchos nombres, o una sola palabra en
// común contra un candidato con muchas palabras de más), se exige que esa
// palabra sea una porción importante del nombre candidato.
const ExcelJS = require('exceljs');

const ALIAS_COLUMNAS = {
  codigo: ['codigo', 'codigodebarras', 'codigobarras', 'codbarras', 'ean', 'itemcode', 'code'],
  nombre: ['producto', 'nombre', 'articulo', 'descripcion', 'description', 'item', 'detalle'],
  precio: ['precio', 'precioporbotella', 'preciounitario', 'price', 'averagecost', 'costbottle', 'costo', 'costobotella', 'costoporbotella'],
  tamanoMl: ['bottlesizeml', 'tamanobotella', 'tamanoml', 'tamano', 'bottlesize', 'mlbotella', 'ml'],
};

const PALABRAS_IGNORADAS = new Set([
  'italia', 'francia', 'inglaterra', 'escocia', 'irlanda', 'alemania',
  'argentina', 'cuba', 'mexico', 'jamaica', 'polonia', 'suecia', 'rusia',
  'espana', 'barbados', 'guatemala', 'sudafrica', 'holanda', 'peru',
  'colombia', 'chile', 'brasil', 'portugal', 'japon', 'china', 'india',
  'generico', 'generica',
]);

function normalizarTexto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(p => p.length > 1 && !PALABRAS_IGNORADAS.has(p));
}
function normalizarCodigo(s) {
  return String(s || '').trim().toLowerCase();
}

// Ver la explicación larga arriba de por qué el puntaje es asimétrico y por
// qué el filtro de precisión cuando sólo matchea una palabra.
function evaluarMatch(buscado, candidato) {
  const pa = normalizarTexto(buscado);
  const pb = normalizarTexto(candidato);
  const pbSet = new Set(pb);
  if (!pa.length || !pbSet.size) return { score: 0, precision: 0 };
  const comunes = pa.filter(p => pbSet.has(p)).length;
  if (comunes === 0) return { score: 0, precision: 0 };
  const precision = comunes / pb.length;
  if (comunes === 1 && pa.length >= 2 && precision < 0.34) return { score: 0, precision: 0 };
  return { score: comunes / pa.length, precision };
}
function mejorMatchPorNombre(buscado, productos) {
  let mejor = null;
  for (const p of productos) {
    const { score, precision } = evaluarMatch(buscado, p.nombre);
    if (score < 0.5) continue;
    if (!mejor || score > mejor.score || (score === mejor.score && precision > mejor.precision)) {
      mejor = { ...p, score, precision };
    }
  }
  return mejor;
}

// Intenta leer el tamaño de botella (en ml) del propio nombre del producto
// (ej. "x750cc", "X 1L", "750 ML", "x L" = por litro).
function parsearTamanoDelNombre(nombre) {
  const n = String(nombre || '').toUpperCase();
  let m = n.match(/X\s?(\d{3,4})\s?(CC|ML|C)?\b/);
  if (m) return parseInt(m[1], 10);
  m = n.match(/(\d{3,4})\s?(CC|ML)\b/);
  if (m) return parseInt(m[1], 10);
  if (/X\s?1\s?L\b/.test(n) || /X\s?L\b/.test(n) || /X\s?1LT\b/.test(n)) return 1000;
  return null;
}

function normalizarColKey(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}
function detectarColumnas(encabezados) {
  const mapa = {};
  encabezados.forEach((valor, idx) => {
    const norm = normalizarColKey(valor);
    if (!norm) return;
    for (const [clave, alias] of Object.entries(ALIAS_COLUMNAS)) {
      if (mapa[clave] !== undefined) continue;
      if (alias.includes(norm)) mapa[clave] = idx;
    }
  });
  return mapa;
}
function encontrarEncabezadoHoja(hoja) {
  const maxFilasABuscar = Math.min(6, hoja.rowCount);
  for (let i = 1; i <= maxFilasABuscar; i++) {
    const valores = hoja.getRow(i).values.slice(1);
    const columnas = detectarColumnas(valores);
    if (columnas.nombre !== undefined && columnas.precio !== undefined) return { fila: i, columnas };
  }
  return null;
}
function aNumero(valorCrudo) {
  if (valorCrudo === null || valorCrudo === undefined || valorCrudo === '') return null;
  if (typeof valorCrudo === 'number') return valorCrudo;
  if (typeof valorCrudo === 'object' && valorCrudo.result !== undefined) return aNumero(valorCrudo.result);
  const limpio = String(valorCrudo).replace(/\$/g, '').replace(/\./g, '').replace(',', '.').trim();
  const num = parseFloat(limpio);
  return isNaN(num) ? null : num;
}

/**
 * Lee un .xlsx/.xls/.csv y devuelve las filas de TODAS las hojas que
 * tengan al menos una columna de nombre y una de precio reconocibles.
 * Lanza error solo si NINGUNA hoja las tiene (ej. le subieron un archivo
 * de costeo de tragos en vez de una lista de precios).
 */
async function parsearArchivoPreciosAyb(rutaArchivo, nombreOriginal) {
  const workbook = new ExcelJS.Workbook();
  const esCsv = /\.csv$/i.test(nombreOriginal || rutaArchivo);
  if (esCsv) await workbook.csv.readFile(rutaArchivo);
  else await workbook.xlsx.readFile(rutaArchivo);

  const filas = [];
  const hojasOmitidas = [];

  for (const hoja of workbook.worksheets) {
    if (hoja.rowCount < 2) continue;
    const encabezado = encontrarEncabezadoHoja(hoja);
    if (!encabezado) { hojasOmitidas.push(hoja.name); continue; }
    const { fila: filaEncabezado, columnas } = encabezado;

    hoja.eachRow((row, numFila) => {
      if (numFila <= filaEncabezado) return;
      const valores = row.values.slice(1);
      const celda = (idx) => (idx === undefined ? '' : String(valores[idx] ?? '').trim());

      const nombre = celda(columnas.nombre);
      const precio = aNumero(valores[columnas.precio]);
      if (!nombre || precio == null) return; // fila vacía o sin precio, se ignora

      filas.push({
        nombre,
        precio,
        codigo: celda(columnas.codigo) || null,
        tamanoMl: aNumero(valores[columnas.tamanoMl]),
      });
    });
  }

  if (filas.length === 0) {
    throw new Error('No se encontró una columna de nombre de producto Y una de precio en ninguna hoja del archivo (probá con encabezados como "Producto"/"Nombre" y "Precio"/"Average Cost").');
  }
  return { filas, hojasOmitidas };
}

/**
 * Calcula qué se actualizaría (no escribe nada). `opciones.modoPrecio`:
 * 'directo' = el precio del archivo ya es por ml/unidad de receta, se usa
 * tal cual. 'botella' = el precio es por unidad de compra completa, hay
 * que convertir a por-ml usando el tamaño (de la columna, si no del
 * nombre, si no 750ml por default). `opciones.soloSiCero` (default true)
 * = no proponer cambio para productos que ya tienen un precio > 0 cargado.
 */
async function previsualizarPreciosAyb(filas, db, opciones = {}) {
  const modoPrecio = opciones.modoPrecio === 'directo' ? 'directo' : 'botella';
  const soloSiCero = opciones.soloSiCero !== false;

  const productos = await db.all2('SELECT id, nombre, precio_unitario, codigo_barras FROM productos_ayb');
  const porCodigo = new Map(productos.filter(p => p.codigo_barras).map(p => [normalizarCodigo(p.codigo_barras), p]));

  const resultado = { aActualizar: [], yaTienenOtroPrecio: [], sinMatch: [], tamanoAsumido: [] };

  for (const fila of filas) {
    let match = fila.codigo ? porCodigo.get(normalizarCodigo(fila.codigo)) : null;
    if (!match) match = mejorMatchPorNombre(fila.nombre, productos);
    if (!match) { resultado.sinMatch.push(fila); continue; }

    let precioPorMl;
    let tamanoUsado = null;
    let tamanoAsumido = false;
    if (modoPrecio === 'directo') {
      precioPorMl = fila.precio;
    } else {
      tamanoUsado = fila.tamanoMl || parsearTamanoDelNombre(fila.nombre);
      if (!tamanoUsado) { tamanoUsado = 750; tamanoAsumido = true; }
      precioPorMl = fila.precio / tamanoUsado;
    }

    const item = { fila, match, precioNuevo: precioPorMl, precioActual: parseFloat(match.precio_unitario) || 0, tamanoUsado, tamanoAsumido };
    if (tamanoAsumido) resultado.tamanoAsumido.push(item);

    if (item.precioActual > 0 && soloSiCero) resultado.yaTienenOtroPrecio.push(item);
    else resultado.aActualizar.push(item);
  }

  return resultado;
}

/** Aplica el resultado de previsualizarPreciosAyb (sólo el bloque aActualizar). */
async function aplicarPreciosAyb(aActualizar, db) {
  for (const item of aActualizar) {
    await db.run2('UPDATE productos_ayb SET precio_unitario=$1 WHERE id=$2', [item.precioNuevo, item.match.id]);
  }
  const idsActualizados = [...new Set(aActualizar.map(a => a.match.id))];
  if (idsActualizados.length === 0) return { productosActualizados: 0, platosRecalculados: 0 };

  const platosAfectados = await db.all2(
    'SELECT DISTINCT plato_id FROM plato_insumos_ayb WHERE insumo_id = ANY($1)',
    [idsActualizados]
  );
  for (const { plato_id } of platosAfectados) {
    await db.run2(
      'UPDATE plato_insumos_ayb SET costo_parcial = cantidad * (SELECT precio_unitario FROM productos_ayb WHERE id = plato_insumos_ayb.insumo_id) WHERE plato_id=$1',
      [plato_id]
    );
    const suma = await db.get2('SELECT COALESCE(SUM(costo_parcial),0) AS total FROM plato_insumos_ayb WHERE plato_id=$1', [plato_id]);
    await db.run2('UPDATE platos_costo SET costo_total=$1 WHERE id=$2', [suma.total, plato_id]);
  }
  return { productosActualizados: idsActualizados.length, platosRecalculados: platosAfectados.length };
}

module.exports = { parsearArchivoPreciosAyb, previsualizarPreciosAyb, aplicarPreciosAyb };
