const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido, requiereDepartamento } = require('./middleware');
router.use(loginRequerido, requiereDepartamento('/horarios'));
const ExcelJS = require('exceljs');

const SECTORES = [
  'Supervisores','Comis de Recepción','Panadería',
  'Pastelería AM','Pastelería PM','Faro AM','Faro PM',
  'Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'
];

const ESTADOS = ['OFF','VAC','RECOFF','LIBRE','ART','LICENCIA','CUMPLE','MUDANZA'];

// ── Helpers de fecha ────────────────────────────────────

// Se mantienen por compatibilidad con enlaces viejos que todavía manden ?fecha=
function getLunes(fechaStr) {
  const d = new Date(fechaStr + 'T00:00:00');
  const day = d.getDay();
  const diff = (day === 0) ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  
  return d.toISOString().split('T')[0];
}

function getDiasSemana(lunes) {
  const dias = [];
  const d = new Date(lunes + 'T00:00:00');
  for (let i = 0; i < 7; i++) {
    dias.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return dias;
}

function sumarDias(fechaStr, n) {
  const d = new Date(fechaStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// Nuevo: rango libre entre dos fechas (inclusive), cualquier cantidad de días
function getDiasRango(inicioStr, finStr) {
  const dias = [];
  let d = new Date(inicioStr + 'T00:00:00');
  const dFin = new Date(finStr + 'T00:00:00');
  let cursor = d <= dFin ? d : dFin;
  let limite = d <= dFin ? dFin : d;
  while (cursor <= limite) {
    dias.push(cursor.toISOString().split('T')[0]);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dias;
}

// Resuelve inicio/fin a partir de los distintos formatos de query que puede recibir
// (?inicio=&fin=  |  ?fecha=  viejo, semana completa  |  nada, semana actual)
function resolverRango(query) {
  const hoy = new Date().toISOString().split('T')[0];
  if (query.inicio) {
    return { inicio: query.inicio, fin: query.fin || query.inicio };
  }
  if (query.fecha) {
    const inicio = getLunes(query.fecha);
    return { inicio, fin: sumarDias(inicio, 6) };
  }
  const inicio = getLunes(hoy);
  return { inicio, fin: sumarDias(inicio, 6) };
}

// Solo supervisores y admins pueden borrar horarios ya cargados
function esSupervisorOAdmin(req) {
  const rol = (req.session?.usuario?.rol || '').toLowerCase();
  return rol === 'supervisor' || rol === 'admin';
}

// AYB no se organiza con la grilla de estados de Cocina (no tiene sentido
// para ellos: no son turnos fijos por sector, son mozos eventuales). Acá es
// donde cada mozo carga su propia disponibilidad horaria — puede tildar
// varios días del mes y ponerles un mismo horario de una sola vez. Lo que
// se ve reflejado (la tabla de equipo armada con esto) vive en "Miembro de
// equipo", no acá — así no queda todo mezclado en la misma pantalla.
function renderMiCalendarioAyb(req, res) {
  res.render('horarios_ayb', { path: 'horarios', usuario: req.session.usuario });
}

// ── Eventos AYB: el encargado carga eventos (nombre, horario, cupo de
// mozos) en el mismo almanaque; los mozos se anotan hasta llenar el cupo.
// "Gestionar" (cargar/ocultar/eliminar) es de supervisor/admin de AYB (o
// admin general); "ver y anotarse" es de cualquiera con acceso a Horarios
// de AYB, para no mezclar con Cocina.
function puedeGestionarEventosAyb(req) {
  const u = req.session.usuario;
  if (!u) return false;
  const departamento = (u.departamento || '').toLowerCase();
  const rol = (u.rol || '').toLowerCase();
  const enAyb = departamento === 'ayb' || !departamento || departamento === 'sistema';
  return enAyb && (rol === 'admin' || rol === 'supervisor');
}
// Convierte un evento (fecha + horario) a un rango {inicio, fin} en objetos
// Date, para poder comparar descansos entre eventos. Si el horario cruza
// medianoche (ej. 19:00 a 01:00) el "fin" cae al día siguiente. Sin
// hora_hasta cargada, asumimos una duración de 4hs para el chequeo (mejor
// una estimación conservadora que no poder avisar nada).
function rangoEvento(fecha, horaDesde, horaHasta) {
  const inicio = new Date(`${fecha}T${horaDesde}:00`);
  let fin;
  if (horaHasta) {
    fin = new Date(`${fecha}T${horaHasta}:00`);
    if (fin <= inicio) fin.setDate(fin.getDate() + 1);
  } else {
    fin = new Date(inicio.getTime() + 4 * 60 * 60 * 1000);
  }
  return { inicio, fin };
}

// Chequea, para un mozo, si anotarse a "eventoNuevo" lo deja con menos de
// 12hs libres respecto a algún otro evento en el que ya esté anotado. No
// bloquea la anotación — solo devuelve un texto de aviso (o null) para
// mostrarle antes de confirmar. Mira eventos del día anterior al
// siguiente, para cubrir los que cruzan medianoche.
async function chequearDescanso12hs(usuarioId, eventoId, fecha, horaDesde, horaHasta) {
  const HORAS_DESCANSO_MIN = 12;
  const otros = await db.all2(`
    SELECT e.id, e.nombre, e.fecha::text, e.hora_desde, e.hora_hasta
    FROM eventos_ayb e
    JOIN eventos_ayb_inscripciones i ON i.evento_id = e.id
    WHERE i.usuario_id = $1 AND e.id != $2
      AND e.fecha BETWEEN ($3::date - INTERVAL '1 day') AND ($3::date + INTERVAL '1 day')
  `, [usuarioId, eventoId, fecha]);

  if (!otros.length) return null;

  const { inicio: inicioNuevo, fin: finNuevo } = rangoEvento(fecha, horaDesde, horaHasta);
  let peorAviso = null, peorGapHoras = Infinity;

  for (const otro of otros) {
    const { inicio: inicioOtro, fin: finOtro } = rangoEvento(otro.fecha, otro.hora_desde, otro.hora_hasta);
    let gapMs;
    if (finOtro <= inicioNuevo) gapMs = inicioNuevo - finOtro;
    else if (finNuevo <= inicioOtro) gapMs = inicioOtro - finNuevo;
    else gapMs = 0; // se superponen directamente
    const gapHoras = gapMs / (60 * 60 * 1000);
    if (gapHoras < HORAS_DESCANSO_MIN && gapHoras < peorGapHoras) {
      peorGapHoras = gapHoras;
      peorAviso = gapHoras <= 0
        ? `Este evento se superpone con "${otro.nombre}" (${otro.fecha}), en el que ya estás anotado.`
        : `Vas a tener solo ${gapHoras.toFixed(1)}hs de descanso entre este evento y "${otro.nombre}" (${otro.fecha}).`;
    }
  }
  return peorAviso;
}

function puedeVerEventosAyb(req) {
  const u = req.session.usuario;
  if (!u) return false;
  const departamento = (u.departamento || '').toLowerCase();
  return departamento === 'ayb' || !departamento || departamento === 'sistema';
}

router.get('/eventos', loginRequerido, async (req, res) => {
  try {
    if (!puedeVerEventosAyb(req)) return res.status(403).json({ ok: false, error: 'No autorizado.' });
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : null;
    if (!mes) return res.json({ ok: false, error: 'Falta el mes (YYYY-MM).' });
    const esGestor = puedeGestionarEventosAyb(req);
    const uid = req.session.usuario.id;

    const filas = await db.all2(`
      SELECT e.id, e.nombre, e.fecha::text AS fecha, e.hora_desde, e.hora_hasta, e.cupo, e.oculto,
             COUNT(i.id)::int AS anotados,
             BOOL_OR(i.usuario_id = $1) AS yo_anotado
      FROM eventos_ayb e
      LEFT JOIN eventos_ayb_inscripciones i ON i.evento_id = e.id
      WHERE to_char(e.fecha, 'YYYY-MM') = $2
      GROUP BY e.id
      ORDER BY e.fecha, e.hora_desde
    `, [uid, mes]);

    const eventos = filas
      .filter(f => esGestor || !f.oculto)
      .map(f => ({
        id: f.id, nombre: f.nombre, fecha: f.fecha,
        hora_desde: f.hora_desde, hora_hasta: f.hora_hasta,
        cupo: f.cupo, anotados: f.anotados, oculto: f.oculto,
        yo_anotado: !!f.yo_anotado, cubierto: f.anotados >= f.cupo
      }));

    res.json({ ok: true, eventos, esGestor });
  } catch (e) {
    console.error('Error listando eventos AYB:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// Informe de disponibilidad de los mozos AYB, mes a mes, para que el
// encargado sepa a quién puede convocar antes de mandarle el WhatsApp
// (manual — el botón de WhatsApp solo arma el link con el mensaje).
router.get('/disponibilidad-resumen', loginRequerido, async (req, res) => {
  try {
    if (!puedeGestionarEventosAyb(req)) return res.status(403).json({ ok: false, error: 'No autorizado.' });
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : null;
    if (!mes) return res.json({ ok: false, error: 'Falta el mes (YYYY-MM).' });

    const filas = await db.all2(`
      SELECT d.fecha::text AS fecha, d.hora_desde, d.hora_hasta,
             u.id AS usuario_id, u.nombre, u.celular
      FROM disponibilidad d
      JOIN usuarios u ON u.id = d.usuario_id
      WHERE d.disponible = true
        AND u.departamento = 'ayb'
        AND to_char(d.fecha, 'YYYY-MM') = $1
      ORDER BY d.fecha, u.nombre
    `, [mes]);

    const dias = {};
    filas.forEach(f => {
      if (!dias[f.fecha]) dias[f.fecha] = [];
      dias[f.fecha].push({
        usuario_id: f.usuario_id, nombre: f.nombre, celular: f.celular,
        hora_desde: f.hora_desde, hora_hasta: f.hora_hasta
      });
    });
    res.json({ ok: true, dias });
  } catch (e) {
    console.error('Error en disponibilidad-resumen AYB:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/eventos', loginRequerido, async (req, res) => {
  try {
    if (!puedeGestionarEventosAyb(req)) return res.status(403).json({ ok: false, error: 'No autorizado.' });
    const nombre = String(req.body.nombre || '').trim();
    const fecha = req.body.fecha;
    const hora_desde = String(req.body.hora_desde || '').trim();
    const hora_hasta = req.body.hora_hasta ? String(req.body.hora_hasta).trim() : null;
    const cupo = parseInt(req.body.cupo, 10);
    if (!nombre || !fecha || !hora_desde || !cupo || cupo < 1) {
      return res.json({ ok: false, error: 'Faltan datos del evento (nombre, fecha, horario desde y cupo).' });
    }
    const fila = await db.get2(
      `INSERT INTO eventos_ayb (nombre, fecha, hora_desde, hora_hasta, cupo, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [nombre, fecha, hora_desde, hora_hasta, cupo, req.session.usuario.id]
    );
    res.json({ ok: true, id: fila.id });
  } catch (e) {
    console.error('Error creando evento AYB:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/eventos/:id/editar', loginRequerido, async (req, res) => {
  try {
    if (!puedeGestionarEventosAyb(req)) return res.status(403).json({ ok: false, error: 'No autorizado.' });
    const nombre = String(req.body.nombre || '').trim();
    const fecha = req.body.fecha;
    const hora_desde = String(req.body.hora_desde || '').trim();
    const hora_hasta = req.body.hora_hasta ? String(req.body.hora_hasta).trim() : null;
    const cupo = parseInt(req.body.cupo, 10);
    if (!nombre || !fecha || !hora_desde || !cupo || cupo < 1) {
      return res.json({ ok: false, error: 'Faltan datos del evento (nombre, fecha, horario desde y cupo).' });
    }
    const actual = await db.get2(
      `SELECT COUNT(*)::int AS anotados FROM eventos_ayb_inscripciones WHERE evento_id=$1`,
      [req.params.id]
    );
    if (actual && cupo < actual.anotados) {
      return res.json({ ok: false, error: `Ya hay ${actual.anotados} mozo${actual.anotados !== 1 ? 's' : ''} anotado${actual.anotados !== 1 ? 's' : ''} — el cupo no puede ser menor a eso.` });
    }
    const fila = await db.get2(
      `UPDATE eventos_ayb SET nombre=$1, fecha=$2, hora_desde=$3, hora_hasta=$4, cupo=$5
       WHERE id=$6 RETURNING id`,
      [nombre, fecha, hora_desde, hora_hasta, cupo, req.params.id]
    );
    if (!fila) return res.json({ ok: false, error: 'Evento no encontrado.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('Error editando evento AYB:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/eventos/:id/ocultar', loginRequerido, async (req, res) => {
  try {
    if (!puedeGestionarEventosAyb(req)) return res.status(403).json({ ok: false, error: 'No autorizado.' });
    const oculto = req.body.oculto === true || req.body.oculto === 'true';
    await db.run2('UPDATE eventos_ayb SET oculto=$1 WHERE id=$2', [oculto, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error ocultando evento AYB:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/eventos/:id/eliminar', loginRequerido, async (req, res) => {
  try {
    if (!puedeGestionarEventosAyb(req)) return res.status(403).json({ ok: false, error: 'No autorizado.' });
    await db.run2('DELETE FROM eventos_ayb WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error eliminando evento AYB:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/eventos/:id/anotarse', loginRequerido, async (req, res) => {
  try {
    if (!puedeVerEventosAyb(req)) return res.status(403).json({ ok: false, error: 'No autorizado.' });
    const evento = await db.get2('SELECT cupo, fecha::text, hora_desde, hora_hasta FROM eventos_ayb WHERE id=$1', [req.params.id]);
    if (!evento) return res.json({ ok: false, error: 'El evento no existe.' });
    const conteo = await db.get2('SELECT COUNT(*)::int AS n FROM eventos_ayb_inscripciones WHERE evento_id=$1', [req.params.id]);
    if (conteo.n >= evento.cupo) return res.json({ ok: false, error: 'El cupo ya está completo.' });
    await db.run2(
      'INSERT INTO eventos_ayb_inscripciones (evento_id, usuario_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.params.id, req.session.usuario.id]
    );
    // No bloquea la anotación — solo avisa si queda con menos de 12hs
    // libres respecto a otro evento en el que ya esté anotado.
    const aviso = await chequearDescanso12hs(req.session.usuario.id, parseInt(req.params.id), evento.fecha, evento.hora_desde, evento.hora_hasta);
    res.json({ ok: true, aviso });
  } catch (e) {
    console.error('Error anotando a evento AYB:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/eventos/:id/desanotarse', loginRequerido, async (req, res) => {
  try {
    if (!puedeVerEventosAyb(req)) return res.status(403).json({ ok: false, error: 'No autorizado.' });
    await db.run2('DELETE FROM eventos_ayb_inscripciones WHERE evento_id=$1 AND usuario_id=$2', [req.params.id, req.session.usuario.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error desanotando de evento AYB:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// Lista de anotados a un evento, para que el gestor marque asistencia real
// ("vino"/"no vino"), separado de "se anotó". Solo gestor.
router.get('/eventos/:id/inscriptos', loginRequerido, async (req, res) => {
  try {
    if (!puedeGestionarEventosAyb(req)) return res.status(403).json({ ok: false, error: 'No autorizado.' });
    const inscriptos = await db.all2(`
      SELECT u.id AS usuario_id, u.nombre, i.asistio
      FROM eventos_ayb_inscripciones i
      JOIN usuarios u ON u.id = i.usuario_id
      WHERE i.evento_id = $1
      ORDER BY u.nombre
    `, [req.params.id]);
    res.json({ ok: true, inscriptos });
  } catch (e) {
    console.error('Error listando inscriptos AYB:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/eventos/:id/inscripciones/:usuarioId/asistencia', loginRequerido, async (req, res) => {
  try {
    if (!puedeGestionarEventosAyb(req)) return res.status(403).json({ ok: false, error: 'No autorizado.' });
    // 'si' | 'no' | 'limpiar' (vuelve a quedar sin marcar)
    const valor = req.body.asistio === 'si' ? true : (req.body.asistio === 'no' ? false : null);
    await db.run2(
      'UPDATE eventos_ayb_inscripciones SET asistio=$1 WHERE evento_id=$2 AND usuario_id=$3',
      [valor, req.params.id, req.params.usuarioId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Error marcando asistencia AYB:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// "Mis próximos compromisos": vista consolidada para el mozo — junta sus
// eventos anotados y sus días marcados como disponible, ambos a futuro,
// en una sola lista ordenada por fecha. Antes tenía que cruzar el
// almanaque y la lista de eventos por separado para armarse una idea de
// su semana.
router.get('/mis-compromisos', loginRequerido, async (req, res) => {
  try {
    if (!puedeVerEventosAyb(req)) return res.status(403).json({ ok: false, error: 'No autorizado.' });
    const usuario_id = req.session.usuario.id;

    const eventos = await db.all2(`
      SELECT e.id, e.nombre, e.fecha::text, e.hora_desde, e.hora_hasta
      FROM eventos_ayb e
      JOIN eventos_ayb_inscripciones i ON i.evento_id = e.id
      WHERE i.usuario_id = $1 AND e.fecha >= CURRENT_DATE
      ORDER BY e.fecha, e.hora_desde
    `, [usuario_id]);

    const disponibilidad = await db.all2(`
      SELECT fecha::text, hora_desde, hora_hasta
      FROM disponibilidad
      WHERE usuario_id = $1 AND disponible = true AND fecha >= CURRENT_DATE
      ORDER BY fecha
    `, [usuario_id]);

    res.json({ ok: true, eventos, disponibilidad });
  } catch (e) {
    console.error('Error cargando mis compromisos AYB:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

router.get('/', loginRequerido, async (req, res) => {
  if ((req.session.usuario.departamento || '').toLowerCase() === 'ayb') {
    return renderMiCalendarioAyb(req, res);
  }

  const { inicio, fin } = resolverRango(req.query);
  const dias = getDiasRango(inicio, fin);

  const empleados = await db.all2(`
    SELECT id, nombre, puesto, departamento, recoff_adeudado
    FROM usuarios
    WHERE activo = 1
    ORDER BY
      CASE departamento
        WHEN 'Supervisores'       THEN 1
        WHEN 'Comis de Recepción' THEN 2
        WHEN 'Panadería'          THEN 3
        WHEN 'Pastelería AM'      THEN 4
        WHEN 'Pastelería PM'      THEN 5
        WHEN 'Faro AM'            THEN 6
        WHEN 'Faro PM'            THEN 7
        WHEN 'Nocturno'           THEN 8
        WHEN 'BQTs Fríos'         THEN 9
        WHEN 'BQTs Calientes'     THEN 10
        WHEN 'Farolito'           THEN 11
        WHEN 'Cocina I+D'         THEN 12
        ELSE 99
      END, nombre
  `);

  // Cuántos RECOFF tiene puestos cada uno en TODA la grilla (no solo el rango visible)
  const usadosRaw = await db.all2(`
    SELECT usuario_id, COUNT(*)::int AS usados
    FROM horarios_semanales WHERE UPPER(valor)='RECOFF' GROUP BY usuario_id
  `);
  const recoffUsadosMap = {};
  usadosRaw.forEach(r => { recoffUsadosMap[r.usuario_id] = r.usados; });
  empleados.forEach(e => {
    e.recoff_pendiente = (e.recoff_adeudado || 0) - (recoffUsadosMap[e.id] || 0);
  });

  const horariosRaw = await db.all2(`
    SELECT usuario_id, fecha::text, valor, sector_dia
    FROM horarios_semanales
    WHERE fecha >= $1 AND fecha <= $2
  `, [dias[0], dias[dias.length - 1]]);

  const horariosMap = {};
  const sectorDiaMap = {};
  horariosRaw.forEach(h => {
    if (!horariosMap[h.usuario_id]) horariosMap[h.usuario_id] = {};
    horariosMap[h.usuario_id][h.fecha] = h.valor;
    if (h.sector_dia) {
      if (!sectorDiaMap[h.usuario_id]) sectorDiaMap[h.usuario_id] = {};
      sectorDiaMap[h.usuario_id][h.fecha] = h.sector_dia;
    }
  });

  const porSector = {};
  empleados.forEach(e => {
    const sector = e.departamento || 'Sin sector';
    if (!porSector[sector]) porSector[sector] = [];
    porSector[sector].push(e);
  });

  const alertas = [];
  SECTORES.forEach(sector => {
    if (!porSector[sector]) return;
    dias.forEach(dia => {
      const tieneAlguien = porSector[sector].some(e => {
        const val = horariosMap[e.id]?.[dia];
        return val && !ESTADOS.includes(val.toUpperCase());
      });
      if (!tieneAlguien) {
        const fecha = new Date(dia + 'T00:00:00');
        const nombreDia = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][fecha.getDay()];
        alertas.push({ sector, dia, nombreDia });
      }
    });
  });

  // Navegación: mueve todo el rango hacia atrás/adelante según su propia duración,
  // así un rango de 3 días sigue siendo de 3 días al navegar, y una semana completa
  // sigue siendo una semana completa.
  const duracion = dias.length;
  const rangoAnterior = { inicio: sumarDias(inicio, -duracion), fin: sumarDias(fin, -duracion) };
  const rangoSiguiente = { inicio: sumarDias(inicio, duracion), fin: sumarDias(fin, duracion) };

  res.render('horarios', {
    path: 'horarios',
    inicio, fin, dias, porSector, horariosMap, sectorDiaMap,
    SECTORES, ESTADOS, alertas,
    rangoAnterior, rangoSiguiente,
    puedeReiniciar: esSupervisorOAdmin(req),
    // compatibilidad con la vista vieja, por si todavía queda alguna referencia a "lunes"
    lunes: inicio
  });
});

router.post('/celda', loginRequerido, async (req, res) => {
  const { usuario_id, fecha, valor } = req.body;
  try {
    const valorNuevo = (valor || '').trim().toUpperCase();

    if (!valor || valor.trim() === '') {
      await db.run2('DELETE FROM horarios_semanales WHERE usuario_id=$1 AND fecha=$2', [parseInt(usuario_id), fecha]);
    } else {
      await db.run2(`
        INSERT INTO horarios_semanales (usuario_id, fecha, valor)
        VALUES ($1, $2, $3)
        ON CONFLICT (usuario_id, fecha) DO UPDATE SET valor = $3
      `, [parseInt(usuario_id), fecha, valorNuevo]);
    }

    // Pendiente real = adeudado (cargado a mano en Personal) - RECOFF que ya tiene puestos en toda la grilla
    const filaAdeudado = await db.get2('SELECT recoff_adeudado FROM usuarios WHERE id=$1', [usuario_id]);
    const usados = await db.get2(
      "SELECT COUNT(*)::int AS c FROM horarios_semanales WHERE usuario_id=$1 AND UPPER(valor)='RECOFF'",
      [usuario_id]
    );
    const pendiente = (filaAdeudado?.recoff_adeudado || 0) - (usados?.c || 0);

    res.json({ ok: true, recoff_pendiente: pendiente });
  } catch(e) {
    console.error('Error guardando celda:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// Copia el rango inmediatamente anterior (misma duración) al rango destino
router.post('/copiar-semana', loginRequerido, async (req, res) => {
  const { inicio_destino, fin_destino, lunes_destino } = req.body;

  // Compatibilidad: si viene el campo viejo "lunes_destino", tratamos como semana completa
  const destInicio = inicio_destino || lunes_destino;
  const destFin     = fin_destino || (lunes_destino ? sumarDias(lunes_destino, 6) : destInicio);

  try {
    const diasDestino = getDiasRango(destInicio, destFin);
    const duracion = diasDestino.length;
    const origenInicio = sumarDias(destInicio, -duracion);
    const origenFin     = sumarDias(destFin, -duracion);
    const diasOrigen = getDiasRango(origenInicio, origenFin);

    const horariosOrigen = await db.all2(`
      SELECT usuario_id, fecha::text, valor
      FROM horarios_semanales
      WHERE fecha >= $1 AND fecha <= $2
    `, [diasOrigen[0], diasOrigen[diasOrigen.length - 1]]);

    for (const h of horariosOrigen) {
      const idx = diasOrigen.indexOf(h.fecha);
      if (idx === -1 || idx >= diasDestino.length) continue;
      await db.run2(`
        INSERT INTO horarios_semanales (usuario_id, fecha, valor)
        VALUES ($1, $2, $3)
        ON CONFLICT (usuario_id, fecha) DO UPDATE SET valor = $3
      `, [h.usuario_id, diasDestino[idx], h.valor]);
    }

    res.redirect(`/horarios?inicio=${destInicio}&fin=${destFin}`);
  } catch(e) {
    console.error('Error copiando semana:', e.message);
    res.redirect(`/horarios?inicio=${destInicio}&fin=${destFin}`);
  }
});

router.get('/excel', loginRequerido, async (req, res) => {
  const { inicio, fin } = resolverRango(req.query);
  const dias = getDiasRango(inicio, fin);
  const NOMBRES_DIA = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

  const empleados = await db.all2(`
    SELECT id, nombre, puesto, departamento FROM usuarios WHERE activo=1
    ORDER BY CASE departamento
      WHEN 'Supervisores' THEN 1 WHEN 'Comis de Recepción' THEN 2
      WHEN 'Panadería' THEN 3 WHEN 'Pastelería AM' THEN 4
      WHEN 'Pastelería PM' THEN 5 WHEN 'Faro AM' THEN 6
      WHEN 'Faro PM' THEN 7 WHEN 'Nocturno' THEN 8
      WHEN 'BQTs Fríos' THEN 9 WHEN 'BQTs Calientes' THEN 10
      WHEN 'Farolito' THEN 11 WHEN 'Cocina I+D' THEN 12
      ELSE 99 END, nombre
  `);

  const horariosRaw = await db.all2(`
    SELECT usuario_id, fecha::text, valor FROM horarios_semanales
    WHERE fecha >= $1 AND fecha <= $2
  `, [dias[0], dias[dias.length - 1]]);

  const horariosMap = {};
  horariosRaw.forEach(h => {
    if (!horariosMap[h.usuario_id]) horariosMap[h.usuario_id] = {};
    horariosMap[h.usuario_id][h.fecha] = h.valor;
  });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Horarios');

  const ultimaCol = String.fromCharCode('A'.charCodeAt(0) + 1 + dias.length); // 2 cols fijas + N días
  ws.mergeCells(`A1:${ultimaCol}1`);
  const titulo = ws.getCell('A1');
  titulo.value = `HORARIOS — HILTON BUENOS AIRES — ${dias[0]} al ${dias[dias.length - 1]}`;
  titulo.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  titulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  titulo.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  const encRow = ws.addRow(['NOMBRE', 'SECTOR', ...dias.map(d => {
    const fecha = new Date(d + 'T00:00:00');
    return `${NOMBRES_DIA[fecha.getDay()]}\n${d.slice(5)}`;
  })]);
  encRow.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
  });
  ws.getRow(2).height = 30;

  const colores = {
    OFF:'FFFBBF24', VAC:'FFDC2626', RECOFF:'FF22C55E',
    LIBRE:'FFDC2626', FERIADO:'FFDC2626', ART:'FFDC2626',
    LICENCIA:'FFDC2626', CUMPLE:'FFDC2626', MUDANZA:'FFDC2626'
  };
  const coloresSector = [
    'FFDBEAFE','FFECFDF5','FFFEFCE8','FFFFF7ED','FFFDF4FF',
    'FFF0FDF4','FFEFF6FF','FFFDF2F8','FFFFF7F0','FFEEF2FF','FFF7FEE7','FFFEF9C3'
  ];

  let sectorActual = null;
  let sectorIdx = -1;

  empleados.forEach(emp => {
    if (emp.departamento !== sectorActual) {
      sectorActual = emp.departamento;
      sectorIdx++;
      const sRow = ws.addRow([emp.departamento || 'Sin sector', '', ...Array(dias.length).fill('')]);
      ws.mergeCells(`A${sRow.number}:${ultimaCol}${sRow.number}`);
      sRow.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF1E3A5F' } };
      sRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: coloresSector[sectorIdx % coloresSector.length] } };
      sRow.getCell(1).alignment = { horizontal: 'center' };
      sRow.height = 18;
    }
    const fila = [emp.nombre, emp.departamento || ''];
    dias.forEach(d => fila.push(horariosMap[emp.id]?.[d] || ''));
    const row = ws.addRow(fila);
    row.height = 18;
    row.eachCell((c, col) => {
      c.font = { size: 10 };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } }, right: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
      if (col === 1) { c.alignment.horizontal = 'left'; c.font.bold = true; }
      if (col > 2) {
        const val = c.value?.toString().toUpperCase();
        if (val && colores[val]) {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colores[val] } };
          c.font = { bold: true, size: 10 };
        }
      }
    });
  });

  ws.columns = [{ width: 24 }, { width: 18 }, ...Array(dias.length).fill({ width: 10 })];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=horarios_${inicio}_a_${fin}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

// ── POST /reiniciar-semana ────────────────────────────
// Solo supervisores y admins pueden borrar horarios ya cargados
router.post('/reiniciar-semana', loginRequerido, async (req, res) => {
  if (!esSupervisorOAdmin(req)) {
    return res.redirect('/horarios?msg=' + encodeURIComponent('Solo un supervisor puede reiniciar horarios ya cargados.'));
  }

  const { inicio, fin, lunes } = req.body;
  const rangoInicio = inicio || lunes;
  const rangoFin     = fin || (lunes ? sumarDias(lunes, 6) : rangoInicio);
  try {
    const dias = getDiasRango(rangoInicio, rangoFin);
    await db.run2(
      'DELETE FROM horarios_semanales WHERE fecha >= $1 AND fecha <= $2',
      [dias[0], dias[dias.length - 1]]
    );
    res.redirect(`/horarios?inicio=${rangoInicio}&fin=${rangoFin}&msg=reiniciado`);
  } catch(e) {
    console.error('Error reiniciando semana:', e.message);
    res.redirect(`/horarios?inicio=${rangoInicio}&fin=${rangoFin}`);
  }
});

module.exports = router;
