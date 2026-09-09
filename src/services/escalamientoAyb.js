// src/services/escalamientoAyb.js
//
// Motor de "cascada" de invitaciones para cubrir el cupo de mozos de un
// evento de AYB:
//   1) Se invita primero a los mozos "Fijo" (con 24hs para responder).
//   2) Si pasadas esas 24hs el cupo sigue sin cubrirse, se invita a
//      "Eventual" por lo que falta (respetando además la bolsa de 200hs
//      mensuales).
//   3) Si pasadas otras 24hs sigue sin cubrirse, se avisa a las
//      consultoras activas cuántos mozos hacen falta.
// Nunca se reinvita dos veces la misma tanda para el mismo evento (se guía
// por si ya existen filas de esa tanda en eventos_ayb_invitaciones), y
// nunca se invita a nadie que ya rompería de entrada el descanso de 12hs,
// el máximo de 12hs por turno, o (para Eventual) la bolsa mensual — esas
// reglas se reusan tal cual de horarios.js, no se reimplementan acá.
//
// correrEscalamiento() hace UN solo "tick" de todo esto de punta a punta —
// se llama desde el setInterval de iniciarEscalamientoAyb() (arrancado una
// sola vez desde server.js) cada pocos minutos, pero también se puede
// invocar a mano en cualquier momento (por ejemplo desde un test, o desde
// el botón "Revisar convocatorias ahora" de horarios.js) sin esperar el
// reloj real.

const crypto = require('crypto');
const db = require('../db/database');
const { enviarWhatsApp } = require('./whatsapp');
const {
  rangoEvento,
  chequearDescanso12hs,
  HORAS_MAX_TURNO,
  BOLSA_HORAS_MENSUAL_EVENTUAL,
} = require('../routes/horarios');

const HORAS_VENCIMIENTO_INVITACION = 24;

function generarToken() {
  return crypto.randomBytes(24).toString('hex');
}

// URL base para armar el link de la invitación de WhatsApp — no hay un
// dominio público fijo (esto se instala en la PC de Maxi), así que se usa
// la variable de entorno PORTAL_URL si está cargada, y si no
// localhost:PORT (mismo puerto que ya usa el resto del portal, ver
// server.js) — alcanza para la red local del hotel.
function baseUrlPortal() {
  return process.env.PORTAL_URL || `http://localhost:${process.env.PORT || 5000}`;
}

function fmtHorarioEvento(ev) {
  return ev.hora_hasta ? `de ${ev.hora_desde} a ${ev.hora_hasta}` : `desde las ${ev.hora_desde}`;
}

function mensajeInvitacionMozo(evento, mozoNombre, token) {
  const link = `${baseUrlPortal()}/horarios/invitacion/${token}`;
  return `Hola ${mozoNombre}! Te escribimos de Hilton Buenos Aires por el evento "${evento.nombre}" el ${evento.fecha} ${fmtHorarioEvento(evento)}. ¿Podés venir? Respondé acá: ${link} (tenés 24hs para confirmar).`;
}

function mensajeAvisoConsultora(evento, consultoraNombre, gap) {
  return `Hola ${consultoraNombre}! Somos de Hilton Buenos Aires. Necesitamos ${gap} mozo${gap === 1 ? '' : 's'} para el evento "${evento.nombre}" el ${evento.fecha} (${fmtHorarioEvento(evento)}). ¿Nos pueden cubrir?`;
}

// Un mozo NO es elegible para una invitación automática si el turno en sí
// ya supera las 12hs, o si anotarse lo dejaría con menos de 12hs de
// descanso respecto a algo que ya tiene cargado. A diferencia de la
// anotación manual (donde esto solo AVISA y deja seguir), acá directamente
// no se lo invita: no tiene sentido convocarlo a algo que de entrada rompe
// la regla.
async function respetaDescansoYTurno(usuarioId, evento) {
  const { inicio, fin } = rangoEvento(evento.fecha, evento.hora_desde, evento.hora_hasta);
  const horasEvento = (fin - inicio) / (60 * 60 * 1000);
  if (horasEvento > HORAS_MAX_TURNO) return false;
  const aviso = await chequearDescanso12hs(usuarioId, evento.id, evento.fecha, evento.hora_desde, evento.hora_hasta);
  return !aviso;
}

// Solo para Eventuales: la bolsa de 200hs mensuales tampoco se puede
// romper con una invitación automática.
async function respetaBolsaMensual(usuarioId, evento) {
  const mes = evento.fecha.slice(0, 7);
  const { inicio, fin } = rangoEvento(evento.fecha, evento.hora_desde, evento.hora_hasta);
  const horasEvento = (fin - inicio) / (60 * 60 * 1000);
  const filas = await db.all2(`
    SELECT e.fecha::text, e.hora_desde, e.hora_hasta
    FROM eventos_ayb_inscripciones i
    JOIN eventos_ayb e ON e.id = i.evento_id
    WHERE i.usuario_id = $1 AND i.asistio IS DISTINCT FROM false
      AND to_char(e.fecha, 'YYYY-MM') = $2
  `, [usuarioId, mes]);
  let total = 0;
  filas.forEach(f => {
    const r = rangoEvento(f.fecha, f.hora_desde, f.hora_hasta);
    total += (r.fin - r.inicio) / (60 * 60 * 1000);
  });
  return (total + horasEvento) <= BOLSA_HORAS_MENSUAL_EVENTUAL;
}

async function marcarVencidas() {
  await db.run2(`
    UPDATE eventos_ayb_invitaciones SET estado='vencido'
    WHERE estado='pendiente' AND vence_en IS NOT NULL AND vence_en < NOW()
  `);
}

// Fila "marcadora" (sin usuario ni consultora) para dejar constancia de que
// esa tanda se disparó aunque no hubiera nadie elegible a quien invitar.
// Sin esto, si por ejemplo no había ningún Fijo elegible, el sistema nunca
// se enteraría de que "ya se intentó" (no existiría ninguna fila 'fijo') y
// jamás pasaría a la tanda de Eventuales — el avance de tanda se decide
// mirando si ya hay filas de la tanda anterior y si están vencidas. Esta
// fila queda vencida de una: no hay a quién esperarle respuesta.
async function marcarTandaSinElegibles(eventoId, tanda) {
  await db.run2(`
    INSERT INTO eventos_ayb_invitaciones (evento_id, tanda, estado, vence_en, respondido_en)
    VALUES ($1, $2, 'vencido', NOW(), NOW())
  `, [eventoId, tanda]);
}

async function eventosAConvocar() {
  // Eventos a futuro (todavía no pasaron) cuyo cupo no está cubierto.
  return db.all2(`
    SELECT e.id, e.nombre, e.fecha::text, e.hora_desde, e.hora_hasta, e.cupo,
           COUNT(i.id)::int AS anotados
    FROM eventos_ayb e
    LEFT JOIN eventos_ayb_inscripciones i ON i.evento_id = e.id
    WHERE e.fecha >= CURRENT_DATE
    GROUP BY e.id
    HAVING COUNT(i.id) < e.cupo
  `);
}

async function tandaExiste(eventoId, tanda) {
  const fila = await db.get2(`SELECT 1 FROM eventos_ayb_invitaciones WHERE evento_id=$1 AND tanda=$2 LIMIT 1`, [eventoId, tanda]);
  return !!fila;
}

// "Vencida" = ya existe esa tanda para el evento Y ninguna de sus filas
// sigue vigente (todas están pasadas de vence_en). Como todas las filas de
// una misma tanda se crean en el mismo momento, alcanza con mirar si
// quedan filas "aún vigentes".
async function tandaVencida(eventoId, tanda) {
  const fila = await db.get2(`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE vence_en IS NULL OR vence_en >= NOW())::int AS aun_vigentes
    FROM eventos_ayb_invitaciones WHERE evento_id=$1 AND tanda=$2
  `, [eventoId, tanda]);
  if (!fila || fila.n === 0) return false;
  return fila.aun_vigentes === 0;
}

async function convocarFijos(evento) {
  const fijos = await db.all2(`
    SELECT id, nombre, celular FROM usuarios
    WHERE activo=1 AND departamento='ayb' AND modalidad='Fijo'
  `);
  const yaAnotados = await db.all2(`SELECT usuario_id FROM eventos_ayb_inscripciones WHERE evento_id=$1`, [evento.id]);
  const idsAnotados = new Set(yaAnotados.map(r => r.usuario_id));

  const elegibles = [];
  for (const mozo of fijos) {
    if (idsAnotados.has(mozo.id)) continue;
    if (await respetaDescansoYTurno(mozo.id, evento)) elegibles.push(mozo);
  }

  if (!elegibles.length) { await marcarTandaSinElegibles(evento.id, 'fijo'); return 0; }

  for (const mozo of elegibles) {
    const token = generarToken();
    const fila = await db.get2(`
      INSERT INTO eventos_ayb_invitaciones (evento_id, usuario_id, tanda, token, vence_en)
      VALUES ($1,$2,'fijo',$3, NOW() + INTERVAL '${HORAS_VENCIMIENTO_INVITACION} hours')
      RETURNING id
    `, [evento.id, mozo.id, token]);
    await enviarWhatsApp(mozo.celular, mensajeInvitacionMozo(evento, mozo.nombre, token), fila.id);
  }
  return elegibles.length;
}

async function convocarEventuales(evento, gap) {
  const eventuales = await db.all2(`
    SELECT id, nombre, celular FROM usuarios
    WHERE activo=1 AND departamento='ayb' AND modalidad='Eventual'
  `);
  const yaAnotados = await db.all2(`SELECT usuario_id FROM eventos_ayb_inscripciones WHERE evento_id=$1`, [evento.id]);
  const idsAnotados = new Set(yaAnotados.map(r => r.usuario_id));

  const elegibles = [];
  for (const mozo of eventuales) {
    if (elegibles.length >= gap) break;
    if (idsAnotados.has(mozo.id)) continue;
    if (!(await respetaDescansoYTurno(mozo.id, evento))) continue;
    if (!(await respetaBolsaMensual(mozo.id, evento))) continue;
    elegibles.push(mozo);
  }

  if (!elegibles.length) { await marcarTandaSinElegibles(evento.id, 'eventual'); return 0; }

  for (const mozo of elegibles) {
    const token = generarToken();
    const fila = await db.get2(`
      INSERT INTO eventos_ayb_invitaciones (evento_id, usuario_id, tanda, token, vence_en)
      VALUES ($1,$2,'eventual',$3, NOW() + INTERVAL '${HORAS_VENCIMIENTO_INVITACION} hours')
      RETURNING id
    `, [evento.id, mozo.id, token]);
    await enviarWhatsApp(mozo.celular, mensajeInvitacionMozo(evento, mozo.nombre, token), fila.id);
  }
  return elegibles.length;
}

// A diferencia de las tandas de mozos, si no hay ninguna consultora activa
// no hace falta dejar una fila "marcadora": no hay ningún paso posterior
// que dependa de que esta tanda quede vencida (es la última de la
// cascada), así que el próximo tick simplemente vuelve a intentarlo sin
// costo — no hay riesgo de mandar de más porque el loop de acá abajo no
// crea nada si la lista de consultoras está vacía.
async function notificarConsultoras(evento, gap) {
  const consultoras = await db.all2(`SELECT id, nombre, celular FROM consultoras WHERE activo=true`);
  if (!consultoras.length) return 0;
  for (const c of consultoras) {
    const fila = await db.get2(`
      INSERT INTO eventos_ayb_invitaciones (evento_id, consultora_id, tanda, estado, respondido_en)
      VALUES ($1,$2,'consultora','notificado', NOW())
      RETURNING id
    `, [evento.id, c.id]);
    await enviarWhatsApp(c.celular, mensajeAvisoConsultora(evento, c.nombre, gap), fila.id);
  }
  return consultoras.length;
}

// Un solo "tick": revisa todos los eventos futuros con cupo sin cubrir y,
// para cada uno, avanza COMO MUCHO un paso de la cascada (si todavía no se
// mandó ninguna tanda, manda la de Fijos; si la de Fijos ya venció, manda
// la de Eventuales; si la de Eventuales ya venció, avisa a las
// consultoras) — nunca salta dos pasos en el mismo tick, así cada tanda
// tiene su ventana completa de 24hs antes de que se dispare la siguiente.
async function correrEscalamiento() {
  const resumen = { eventosRevisados: 0, fijoEnviadas: 0, eventualEnviadas: 0, consultorasNotificadas: 0 };
  try {
    await marcarVencidas();

    const eventos = await eventosAConvocar();
    resumen.eventosRevisados = eventos.length;

    for (const evento of eventos) {
      const gap = evento.cupo - evento.anotados;
      if (gap <= 0) continue;

      const existeFijo = await tandaExiste(evento.id, 'fijo');
      if (!existeFijo) {
        resumen.fijoEnviadas += await convocarFijos(evento);
        continue;
      }

      const existeEventual = await tandaExiste(evento.id, 'eventual');
      if (!existeEventual) {
        if (await tandaVencida(evento.id, 'fijo')) {
          resumen.eventualEnviadas += await convocarEventuales(evento, gap);
        }
        continue;
      }

      const existeConsultora = await tandaExiste(evento.id, 'consultora');
      if (!existeConsultora) {
        if (await tandaVencida(evento.id, 'eventual')) {
          resumen.consultorasNotificadas += await notificarConsultoras(evento, gap);
        }
      }
    }
  } catch (e) {
    console.error('Error en escalamiento de AYB:', e.message);
  }
  return resumen;
}

let _intervalo = null;
// Se arranca una sola vez desde server.js. La guarda de _intervalo evita
// que, si algo llegara a requerir este módulo más de una vez con un cache
// distinto (no debería pasar en Node normal, pero por las dudas), queden
// dos intervalos corriendo en paralelo y se dupliquen los envíos.
function iniciarEscalamientoAyb(minutos = 5) {
  if (_intervalo) return;
  _intervalo = setInterval(() => {
    correrEscalamiento().catch(e => console.error('Error en tick de escalamiento AYB:', e.message));
  }, minutos * 60 * 1000);
}

module.exports = { correrEscalamiento, iniciarEscalamientoAyb };
