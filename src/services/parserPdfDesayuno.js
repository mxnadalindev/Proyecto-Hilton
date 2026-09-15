// src/services/parserPdfDesayuno.js — Lector determinístico (sin IA) del PDF
// "Breakfast Package" que exporta el sistema de reservas del hotel.
//
// Por qué existe además del lector con Gemini (ver gemini.js /
// analizarReporteDesayuno): Gemini tiene una cuota gratuita diaria y, al
// acabarse, deja de leer PDFs hasta el día siguiente. Este lector no usa
// IA — lee el texto real embebido en el PDF y reconstruye la tabla mirando
// la POSICIÓN de cada dato en la página (igual que se leería a ojo), así
// que no depende de ninguna cuota y funciona todas las veces.
//
// Limitación a tener en cuenta: como funciona por posición, está afinado
// para el diseño de ESTE reporte puntual (columnas: Room No., Full Name,
// Membership Level, Adults, Children, Arrival Date, Departure Date, Resv
// Status, Group Name, Company Name, Special Request, Ttl Pkg. Amt.). Si el
// sistema de reservas cambia el diseño del reporte, o el PDF es una imagen
// escaneada sin texto seleccionable, este lector puede no encontrar filas
// — en ese caso, quien llama a esta función debería recurrir al lector con
// Gemini como respaldo (así está armado en src/routes/desayuno.js).
const fs = require('fs');

// Posición horizontal (centro del texto, en puntos PDF) de cada columna,
// medida sobre el reporte real que Maxi compartió. El reporte alinea cada
// columna centrada sobre un punto fijo — no importa si el valor es largo o
// corto, el CENTRO del texto siempre cae en el mismo lugar. Por eso se
// clasifica cada fragmento de texto por cercanía a estos centros, en vez
// de por su posición de inicio (que sí varía según el largo del texto).
const ANCLAS_COLUMNA = [
  { campo: 'habitacion', x: 13 },
  { campo: 'nombre', x: 83 },
  { campo: 'membershipLevel', x: 142 },
  { campo: 'adultos', x: 206 },
  { campo: 'ninos', x: 297 },
  { campo: 'fechaLlegada', x: 373 },
  { campo: 'fechaSalida', x: 434 },
  { campo: 'estado', x: 487 },
  { campo: 'groupName', x: 530 },
  { campo: 'companyName', x: 590 },
  { campo: 'specialRequest', x: 664 },
  { campo: 'ttlPkgAmt', x: 754 },
];

// Banda vertical donde vive la tabla de datos en cada página — arriba del
// encabezado repetido ("Room No. / Full Name / ...", que aparece ~502-540)
// y abajo del pie de página ("Filter ... Page X of Y", que aparece ~55-65).
const Y_MIN_DATOS = 65;
const Y_MAX_DATOS = 502;

// El PDF a veces arrastra, pegado a la columna de Group/Company/Special,
// texto suelto de un calendarcito que no tiene que ver con el dato real
// (aparece como "Septiembre" / "2026" sueltos). Se descarta si coincide
// exactamente con un nombre de mes o con un número de 4 dígitos tipo año.
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function esRuidoDeCalendario(token) {
  const t = (token || '').trim().toLowerCase();
  if (!t) return true;
  if (MESES.includes(t)) return true;
  if (/^(19|20)\d{2}$/.test(t)) return true;
  return false;
}

function columnaMasCercana(center) {
  let mejorCampo = ANCLAS_COLUMNA[0].campo;
  let mejorDistancia = Infinity;
  for (const ancla of ANCLAS_COLUMNA) {
    const distancia = Math.abs(center - ancla.x);
    if (distancia < mejorDistancia) { mejorDistancia = distancia; mejorCampo = ancla.campo; }
  }
  return mejorCampo;
}

function aFechaISO(ddmmyy) {
  const m = /^(\d{2})-(\d{2})-(\d{2})$/.exec((ddmmyy || '').trim());
  if (!m) return null;
  const [, dd, mm, yy] = m;
  return `20${yy}-${mm}-${dd}`;
}

/**
 * Lee el PDF del "Breakfast Package" y devuelve las filas en el mismo
 * formato que ya usa el resto del módulo Desayuno (parsearArchivoDesayuno
 * en importadorDesayuno.js, y analizarReporteDesayuno en gemini.js):
 *   { fechaReporte: 'YYYY-MM-DD'|null, filas: [{ habitacion, nombre, ... }] }
 * Devuelve filas: [] (no tira error) si no logra reconocer ninguna fila —
 * así quien llama puede decidir recurrir al lector con IA como respaldo.
 */
async function parsearPdfDesayuno(rutaArchivo) {
  // pdfjs-dist (v6) es un paquete ESM puro — se importa con import()
  // dinámico aunque el resto del proyecto use CommonJS (require).
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const bytes = fs.readFileSync(rutaArchivo);
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise;

  let fechaReporte = null;
  const filas = [];

  for (let numPagina = 1; numPagina <= doc.numPages; numPagina++) {
    const pagina = await doc.getPage(numPagina);
    const contenido = await pagina.getTextContent();
    const items = contenido.items
      .map(it => ({ str: it.str, x: it.transform[4], y: Math.round(it.transform[5]), w: it.width }))
      .filter(it => it.str.trim() !== '');

    if (!fechaReporte) {
      // Fecha del reporte: aparece arriba a la derecha de cada página,
      // formato dd-mm-aa (ej: "15-09-26").
      const itemFecha = items.find(it => it.y > 570 && it.x > 700 && /^\d{2}-\d{2}-\d{2}$/.test(it.str.trim()));
      if (itemFecha) fechaReporte = aFechaISO(itemFecha.str.trim());
    }

    const datos = items
      .filter(it => it.y > Y_MIN_DATOS && it.y < Y_MAX_DATOS)
      .map(it => ({ ...it, center: it.x + it.w / 2 }));

    // Cada fila empieza con el número de habitación (4 dígitos, pegado al
    // borde izquierdo). Se ordenan de arriba hacia abajo.
    const filasHabitacion = datos
      .filter(it => /^\d{4}$/.test(it.str.trim()) && Math.abs(it.center - 13) < 20)
      .sort((a, b) => b.y - a.y);

    for (let i = 0; i < filasHabitacion.length; i++) {
      const itemHabitacion = filasHabitacion[i];
      const yTope = itemHabitacion.y;
      // El "piso" de la fila es el techo de la siguiente habitación (o el
      // piso de la página, si es la última fila de la página) — así se
      // agarran también las líneas de continuación (nombres/empresas que
      // no entraron en una sola línea).
      const yPiso = i + 1 < filasHabitacion.length ? filasHabitacion[i + 1].y : Y_MIN_DATOS;
      const itemsDeLaFila = datos.filter(it => it.y <= yTope && it.y > yPiso);

      const fila = { habitacion: itemHabitacion.str.trim() };
      for (const it of itemsDeLaFila) {
        if (it === itemHabitacion) continue;
        const campo = columnaMasCercana(it.center);
        if (campo === 'habitacion') continue; // otro número de 4 dígitos que no es el de esta fila
        const texto = it.str.trim();
        if ((campo === 'groupName' || campo === 'companyName' || campo === 'specialRequest') && esRuidoDeCalendario(texto)) continue;
        // Se van pegando los fragmentos de líneas envueltas (nombres o
        // empresas largas que no entran en una sola línea) con un espacio.
        fila[campo] = fila[campo] ? `${fila[campo]} ${texto}` : texto;
      }
      filas.push(fila);
    }
  }

  const filasNormalizadas = filas.map(f => ({
    habitacion: f.habitacion,
    nombre: f.nombre || '',
    membershipLevel: f.membershipLevel || '',
    adultos: parseInt(f.adultos || '0', 10) || 0,
    ninos: parseInt(f.ninos || '0', 10) || 0,
    fechaLlegada: aFechaISO(f.fechaLlegada),
    fechaSalida: aFechaISO(f.fechaSalida),
    estado: f.estado || '',
    groupName: f.groupName || '',
    companyName: f.companyName || '',
    specialRequest: f.specialRequest || '',
    ttlPkgAmt: parseFloat((f.ttlPkgAmt || '0').replace(/,/g, '')) || 0,
  }));

  return { fechaReporte, filas: filasNormalizadas };
}

module.exports = { parsearPdfDesayuno };
