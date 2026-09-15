// src/services/importadorDesayuno.js
//
// Lee el reporte "Breakfast Package" del sistema de reservas cuando viene
// en Excel o CSV (mucho más confiable que el PDF: no hay celdas que se
// corten en varias líneas). Detección de columnas flexible por nombre
// (no por posición), mismo criterio que importadorProductosAyb.js.

const ExcelJS = require('exceljs');

const ALIAS_COLUMNAS = {
  habitacion: ['roomno', 'room', 'habitacion', 'nrohabitacion', 'numerodehabitacion'],
  nombre: ['fullname', 'nombre', 'guest', 'guestname', 'nombrecompleto'],
  membershipLevel: ['membershiplevel', 'membership', 'nivelmembresia', 'membresia'],
  adultos: ['adults', 'adultos'],
  ninos: ['children', 'ninos', 'niños', 'kids'],
  fechaLlegada: ['arrivaldate', 'fechallegada', 'llegada'],
  fechaSalida: ['departuredate', 'fechasalida', 'salida'],
  estado: ['resvstatus', 'reservationstatus', 'estado', 'estadoreserva'],
  groupName: ['groupname', 'grupo', 'nombregrupo'],
  companyName: ['companyname', 'empresa', 'nombreempresa'],
  specialRequest: ['specialrequest', 'pedidoespecial', 'solicitudespecial'],
  ttlPkgAmt: ['ttlpkgamt', 'ttlpkg', 'totalpackageamount', 'montopaquete', 'totalpkgamt'],
};

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function detectarColumnas(encabezados) {
  const mapa = {};
  encabezados.forEach((valor, idx) => {
    const norm = normalizar(valor);
    for (const [clave, alias] of Object.entries(ALIAS_COLUMNAS)) {
      if (mapa[clave] === undefined && alias.includes(norm)) mapa[clave] = idx;
    }
  });
  return mapa;
}

// Convierte una fecha de celda (Date de Excel, o texto dd-mm-aa / dd-mm-aaaa
// / aaaa-mm-dd) a "YYYY-MM-DD". Devuelve "" si no se puede interpretar.
function aFechaISO(valorCrudo) {
  if (!valorCrudo) return '';
  if (valorCrudo instanceof Date) {
    return valorCrudo.toISOString().slice(0, 10);
  }
  const txt = String(valorCrudo).trim();
  let m = txt.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = txt.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (parseInt(y) > 50 ? '19' : '20') + y;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return '';
}

function aNumero(valorCrudo) {
  if (valorCrudo === null || valorCrudo === undefined || valorCrudo === '') return 0;
  if (typeof valorCrudo === 'number') return valorCrudo;
  if (typeof valorCrudo === 'object' && valorCrudo.result !== undefined) return aNumero(valorCrudo.result);
  const limpio = String(valorCrudo).replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.').trim();
  const num = parseFloat(limpio);
  return isNaN(num) ? 0 : num;
}

function valorCelda(celda) {
  if (celda === null || celda === undefined) return '';
  if (typeof celda === 'object' && celda.text !== undefined) return celda.text; // rich text
  if (typeof celda === 'object' && celda.result !== undefined) return celda.result;
  return celda;
}

/**
 * Parsea un archivo .xlsx o .csv del reporte de desayuno.
 * @param {string} rutaArchivo
 * @param {string} nombreOriginal - para decidir csv vs xlsx por extensión
 * @returns {Promise<{fechaReporte: string, filas: Array}>}
 */
async function parsearArchivoDesayuno(rutaArchivo, nombreOriginal) {
  const esCsv = /\.csv$/i.test(nombreOriginal || '');
  let encabezados = [];
  let filasCrudas = [];

  if (esCsv) {
    const fs = require('fs');
    const contenido = fs.readFileSync(rutaArchivo, 'utf8');
    const lineas = contenido.split(/\r?\n/).filter(l => l.trim());
    if (lineas.length === 0) throw new Error('El archivo está vacío.');
    const cantComas = (lineas[0].match(/,/g) || []).length;
    const cantPuntoYComa = (lineas[0].match(/;/g) || []).length;
    const separador = cantPuntoYComa > cantComas ? ';' : ',';
    const partir = (l) => l.split(separador).map(c => c.trim().replace(/^"|"$/g, ''));
    encabezados = partir(lineas[0]);
    filasCrudas = lineas.slice(1).map(partir);
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(rutaArchivo);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('El Excel no tiene ninguna hoja.');
    const filas = [];
    ws.eachRow((row) => {
      const valores = [];
      row.eachCell({ includeEmpty: true }, (cell) => valores.push(valorCelda(cell.value)));
      filas.push(valores);
    });
    if (filas.length === 0) throw new Error('El Excel está vacío.');
    encabezados = filas[0];
    filasCrudas = filas.slice(1);
  }

  const idx = detectarColumnas(encabezados);
  if (idx.habitacion === undefined) {
    throw new Error('No encontré una columna de número de habitación (ej: "Room No."). Revisá que el archivo tenga los mismos encabezados que el reporte del PMS.');
  }

  const filas = [];
  for (const campos of filasCrudas) {
    const habitacion = String(campos[idx.habitacion] ?? '').trim();
    if (!habitacion) continue;
    filas.push({
      habitacion,
      nombre: idx.nombre !== undefined ? String(campos[idx.nombre] ?? '').trim() : '',
      membershipLevel: idx.membershipLevel !== undefined ? String(campos[idx.membershipLevel] ?? '').trim() : '',
      adultos: idx.adultos !== undefined ? Math.round(aNumero(campos[idx.adultos])) : 0,
      ninos: idx.ninos !== undefined ? Math.round(aNumero(campos[idx.ninos])) : 0,
      fechaLlegada: idx.fechaLlegada !== undefined ? aFechaISO(campos[idx.fechaLlegada]) : '',
      fechaSalida: idx.fechaSalida !== undefined ? aFechaISO(campos[idx.fechaSalida]) : '',
      estado: idx.estado !== undefined ? String(campos[idx.estado] ?? '').trim() : '',
      groupName: idx.groupName !== undefined ? String(campos[idx.groupName] ?? '').trim() : '',
      companyName: idx.companyName !== undefined ? String(campos[idx.companyName] ?? '').trim() : '',
      specialRequest: idx.specialRequest !== undefined ? String(campos[idx.specialRequest] ?? '').trim() : '',
      ttlPkgAmt: idx.ttlPkgAmt !== undefined ? aNumero(campos[idx.ttlPkgAmt]) : 0,
    });
  }

  return { fechaReporte: '', filas };
}

module.exports = { parsearArchivoDesayuno };
