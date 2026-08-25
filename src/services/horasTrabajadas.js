const db = require('../db/database');

// Compartido entre personal.js (la tabla de Miembro de equipo) y
// asistente.js (el chatbot) para que las horas que uno y otro reporten
// sean siempre el mismo número, calculado de la misma forma — antes cada
// uno hubiera tenido que reimplementar esto por su cuenta y corríamos el
// riesgo de que se desincronicen con el tiempo.

// Cuántas horas duró un evento AYB, a partir de su horario. Si cruza
// medianoche (ej. 19:00 a 01:00) lo maneja bien; si no tiene hora_hasta
// cargada, asumimos 4hs (mismo criterio que el chequeo de descanso de
// 12hs en horarios.js).
function horasDeEvento(horaDesde, horaHasta) {
  if (!horaHasta) return 4;
  const [hD, mD] = horaDesde.split(':').map(Number);
  const [hH, mH] = horaHasta.split(':').map(Number);
  let minutos = (hH * 60 + mH) - (hD * 60 + mD);
  if (minutos <= 0) minutos += 24 * 60; // cruza medianoche
  return minutos / 60;
}

// Cocina carga el horario de cada día como texto libre (ej: "09-17",
// "9:00 a 17:30") en vez de dos campos separados como AYB. Devuelve las
// horas trabajadas ese día, o null si el texto no es un horario
// reconocible (por ejemplo, si es un estado como "VAC"/"OFF" — eso ya se
// filtra antes de llegar acá — o algo tipeado raro).
const RE_HORARIO_TEXTO = /^(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|a|hs?a|à)\s*(\d{1,2})(?:[:.](\d{2}))?\s*h?s?$/i;
function horasDesdeTexto(texto) {
  if (!texto) return null;
  const m = String(texto).trim().match(RE_HORARIO_TEXTO);
  if (!m) return null;
  const hD = parseInt(m[1], 10), mD = parseInt(m[2] || '0', 10);
  const hH = parseInt(m[3], 10), mH = parseInt(m[4] || '0', 10);
  if (hD > 23 || hH > 23 || mD > 59 || mH > 59) return null;
  let minutos = (hH * 60 + mH) - (hD * 60 + mD);
  if (minutos <= 0) minutos += 24 * 60; // cruza medianoche
  if (minutos > 16 * 60) return null; // más de 16hs seguidas: seguramente no es un horario, descartamos
  return minutos / 60;
}

const ESTADOS_LIBRES = ['OFF', 'VAC', 'RECOFF', 'LIBRE', 'ART', 'LICENCIA', 'CUMPLE', 'MUDANZA', 'FRANCO'];

// Horas trabajadas (y días distintos con horas) de UN usuario puntual, en
// un mes 'YYYY-MM'. Pensado para el chatbot (una consulta a la vez); la
// tabla de Personal usa su propia versión en lote (una sola consulta para
// todo el equipo) por rendimiento, pero con la misma lógica de fondo.
async function horasDelMes(usuarioId, departamento, mesYYYYMM) {
  // .toLowerCase(): mismo motivo que en los demás archivos — el
  // departamento puede venir guardado con distinta capitalización.
  if ((departamento || '').toLowerCase() === 'ayb') {
    const filas = await db.all2(`
      SELECT e.fecha::text AS fecha, e.hora_desde, e.hora_hasta
      FROM eventos_ayb_inscripciones i
      JOIN eventos_ayb e ON e.id = i.evento_id
      WHERE i.usuario_id = $1 AND i.asistio = true AND to_char(e.fecha, 'YYYY-MM') = $2
    `, [usuarioId, mesYYYYMM]);
    let horas = 0;
    const dias = new Set();
    filas.forEach(f => {
      horas += horasDeEvento(f.hora_desde, f.hora_hasta);
      dias.add(f.fecha);
    });
    return { horas: Math.round(horas * 10) / 10, dias: dias.size, eventos: filas.length };
  }

  const filas = await db.all2(`
    SELECT fecha::text AS fecha, valor FROM horarios_semanales
    WHERE usuario_id = $1 AND to_char(fecha, 'YYYY-MM') = $2
  `, [usuarioId, mesYYYYMM]);
  let horas = 0;
  const dias = new Set();
  filas.forEach(f => {
    if (ESTADOS_LIBRES.includes(String(f.valor).toUpperCase())) return;
    const h = horasDesdeTexto(f.valor);
    if (h !== null) { horas += h; dias.add(f.fecha); }
  });
  return { horas: Math.round(horas * 10) / 10, dias: dias.size, eventos: null };
}

module.exports = { horasDeEvento, horasDesdeTexto, horasDelMes, ESTADOS_LIBRES };
