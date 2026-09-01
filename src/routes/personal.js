const express = require('express');
const router = express.Router();
const db = require('../db/database');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { loginRequerido, requiereDepartamento } = require('./middleware');
const { analizarPlanillaMozos, mensajeErrorGemini } = require('../services/gemini');
const { horasDeEvento, horasDesdeTexto } = require('../services/horasTrabajadas');
router.use(loginRequerido, requiereDepartamento('/personal'));

const storageMozos = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, 'mozos_' + Date.now() + path.extname(file.originalname))
});
const uploadMozos = multer({ storage: storageMozos, limits: { fileSize: 10 * 1024 * 1024 } });

const storageMozosFoto = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, 'mozos_foto_' + Date.now() + path.extname(file.originalname))
});
const uploadMozosFoto = multer({ storage: storageMozosFoto, limits: { fileSize: 10 * 1024 * 1024 } });

const PUESTOS = ['Chef','Subchef','Encargado de cocina','Cocinero','Ayudante de cocina','Pastelero','Panadero'];
const ROLES   = ['empleado','supervisor','admin'];
// .normalize('NFC'): defensivo contra el caso en que estos literales con
// tilde queden guardados en el archivo con una forma Unicode distinta
// (NFD) a la que usa Postgres para comparar — sin esto, "departamento =
// ANY($1)" puede fallar en silencio para los sectores con tilde aunque se
// vean idénticos en pantalla (pasó: Comis de Recepción, Panadería,
// Pastelería AM/PM, BQTs Fríos quedaban afuera de las listas).
const SECTORES = ['Supervisores','Comis de Recepción','Panadería','Pastelería AM','Pastelería PM','Faro AM','Faro PM','Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'].map(s => s.normalize('NFC'));
const ESTADOS = ['OFF','VAC','RECOFF','LIBRE','ART','LICENCIA','CUMPLE','MUDANZA','FRANCO'];

// AYB (mozos) no se organiza por "sector" como Cocina — se divide en
// Eventual / Fijo / Agencia. Reemplaza al placeholder de sectores de AYB
// que había antes (era una copia inventada del esquema de Cocina).
const MODALIDADES_AYB = ['Eventual', 'Fijo', 'Agencia'];

// Un mozo "Eventual" de AYB tiene un límite real de contrato de 6 meses
// desde su fecha de alta. Avisamos al encargado con esta anticipación (en
// días) antes de que se cumpla, mismo criterio que la alerta de
// vencimientos de Croutons.
const DIAS_ALERTA_VENCIMIENTO_MOZO = 15;
const MESES_LIMITE_MOZO_EVENTUAL = 6;

// horasDeEvento (AYB) y horasDesdeTexto (Cocina) viven en
// services/horasTrabajadas.js, compartidas con el chatbot — así el mismo
// mes reportado acá y por el asistente siempre da el mismo número.

// El <select> de "cambiar sector solo este día" en la grilla es un concepto
// de Cocina — AYB ya no lo usa (se organiza por modalidad, no por sector),
// así que para AYB no se le ofrecen opciones.
function sectoresPara(usuario) {
  // .toLowerCase(): el departamento de la cuenta puede estar guardado con
  // distinta capitalización según cómo se haya creado (mismo motivo que en
  // obtenerPersonal()).
  if ((usuario.departamento || '').toLowerCase() === 'ayb') return [];
  return SECTORES;
}

// Trae el personal a mostrar en /personal según el departamento de quien
// mira: Cocina sigue filtrando por su lista de sectores (departamento =
// nombre de sector); AYB ahora es plano — todas las filas con
// departamento='ayb', diferenciadas por "modalidad" en vez de sector. Un
// admin sin departamento propio ve ambos grupos juntos.
async function obtenerPersonal(usuarioSesion) {
  const cols = `id,nombre,email,legajo,puesto,rol,activo,departamento,modalidad,creado_en,recoff_adeudado,fecha_alta::text,celular`;
  // Se excluyen las cuentas con rol admin: son credenciales para entrar al
  // sistema y gestionar, no personal a programar — antes se colaban acá
  // (ej. la propia cuenta del encargado de AYB aparecía mezclada en la
  // lista como si fuera un mozo más). LOWER() porque el rol puede estar
  // guardado con distinta capitalización según cómo se haya creado la
  // cuenta (mismo motivo que el chequeo de permisos en horarios.js).
  const NO_ADMIN = `LOWER(rol) != 'admin'`;
  // .toLowerCase(): el departamento de QUIEN MIRA (la cuenta logueada)
  // puede estar guardado con distinta capitalización según cómo se haya
  // creado esa cuenta — sin esto, un admin con departamento "Cocina" (en
  // vez de "cocina") caía siempre en la rama genérica de abajo.
  const miDepto = (usuarioSesion.departamento || '').toLowerCase();
  if (miDepto === 'ayb') {
    return db.all2(`SELECT ${cols} FROM usuarios WHERE departamento='ayb' AND ${NO_ADMIN} ORDER BY modalidad NULLS LAST, nombre`);
  }
  if (miDepto === 'cocina') {
    return db.all2(`SELECT ${cols} FROM usuarios WHERE departamento = ANY($1) AND ${NO_ADMIN} ORDER BY departamento, nombre`, [SECTORES]);
  }
  return db.all2(`SELECT ${cols} FROM usuarios WHERE (departamento = ANY($1) OR departamento='ayb') AND ${NO_ADMIN} ORDER BY departamento, nombre`, [SECTORES]);
}

// ── Helpers de fecha ────────────────────────────────────

// Se mantienen por compatibilidad con /asignar-semana (ruta vieja)
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
  // Si por algún motivo vienen invertidas, las corregimos
  let cursor = d <= dFin ? d : dFin;
  let limite = d <= dFin ? dFin : d;
  while (cursor <= limite) {
    dias.push(cursor.toISOString().split('T')[0]);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dias;
}

// ── GET / ──────────────────────────────────────────────
router.get('/', loginRequerido, async (req, res) => {
  // "Miembro de equipo" (con Vencimientos) es solo para quien gestiona AYB
  // (admin/supervisor) — un mozo común no debe entrar, ni siquiera
  // escribiendo la URL directamente (el link ya está oculto para él, esto
  // es el mismo chequeo del lado del servidor).
  const miDeptoLower = (req.session.usuario.departamento || '').toLowerCase();
  const miRolLower = (req.session.usuario.rol || '').toLowerCase();
  if (miDeptoLower === 'ayb' && miRolLower !== 'admin' && miRolLower !== 'supervisor') {
    return res.redirect('/horarios');
  }

  const hoy = new Date().toISOString().split('T')[0];

  // Compatibilidad: si todavía llega ?semana=..., lo tratamos como el inicio
  // de una semana completa (comportamiento viejo).
  let inicio, fin;
  if (req.query.inicio) {
    inicio = req.query.inicio;
    fin    = req.query.fin || inicio;
  } else if (req.query.semana) {
    inicio = getLunes(req.query.semana);
    fin    = sumarDias(inicio, 6);
  } else {
    inicio = getLunes(hoy);
    fin    = sumarDias(inicio, 6);
  }

  const dias = getDiasRango(inicio, fin);

  // Qué sectores puede ver/gestionar quien está mirando esta pantalla —
  // antes esto estaba fijo a los sectores de Cocina, así que Alimentos y
  // Bebidas nunca veía a su propio personal (ver sectoresPara arriba).
  const sectoresVisibles = sectoresPara(req.session.usuario);
  const misDepto = req.session.usuario.departamento;

  let personal = await obtenerPersonal(req.session.usuario);

  // Filtro "cargados en el calendario": a pedido, cuando se entra a Ver
  // equipo desde el calendario de AYB (el link ahora manda ?mes=YYYY-MM
  // con el mes que se está mirando ahí), se muestra solo a los mozos que
  // tienen algo cargado ese mes — disponibilidad marcada y/o anotados a
  // algún evento — en vez de la lista completa siempre. Si no viene el
  // parámetro (por ejemplo entrando por "Menú principal"), se ve todo
  // como siempre.
  const mesFiltro = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : null;
  if (mesFiltro && miDeptoLower === 'ayb') {
    const cargadosRaw = await db.all2(`
      SELECT DISTINCT usuario_id FROM (
        SELECT usuario_id FROM disponibilidad
        WHERE disponible = true AND to_char(fecha, 'YYYY-MM') = $1
        UNION
        SELECT i.usuario_id FROM eventos_ayb_inscripciones i
        JOIN eventos_ayb e ON e.id = i.evento_id
        WHERE to_char(e.fecha, 'YYYY-MM') = $1
      ) x
    `, [mesFiltro]);
    const idsCargados = new Set(cargadosRaw.map(r => r.usuario_id));
    personal = personal.filter(p => idsCargados.has(p.id));
  }

  // Cuántos RECOFF tiene puestos cada uno en TODA la grilla (no solo el rango visible)
  const usadosRaw = await db.all2(`
    SELECT usuario_id, COUNT(*)::int AS usados
    FROM horarios_semanales WHERE UPPER(valor)='RECOFF' GROUP BY usuario_id
  `);
  const recoffUsadosMap = {};
  usadosRaw.forEach(r => { recoffUsadosMap[r.usuario_id] = r.usados; });
  personal.forEach(p => {
    p.recoff_pendiente_real = (p.recoff_adeudado || 0) - (recoffUsadosMap[p.id] || 0);
  });

  // Límite de 6 meses de los mozos "Eventual" de AYB (desde fecha_alta) +
  // cuántos eventos trabajó de verdad cada uno (asistio=true, no solo
  // anotado). Ambos se calculan siempre que haya al menos un mozo AYB en
  // la lista, no solo cuando quien mira es de AYB, para que un admin
  // general también vea el aviso.
  const idsAyb = personal.filter(p => p.departamento === 'ayb').map(p => p.id);
  const trabajadosMap = {};
  const horasMesMap = {};
  const diasTrabajadosMap = {};
  if (idsAyb.length) {
    const trabajadosRaw = await db.all2(`
      SELECT i.usuario_id, COUNT(*)::int AS trabajados
      FROM eventos_ayb_inscripciones i
      WHERE i.usuario_id = ANY($1) AND i.asistio = true
      GROUP BY i.usuario_id
    `, [idsAyb]);
    trabajadosRaw.forEach(r => { trabajadosMap[r.usuario_id] = r.trabajados; });

    // Horas trabajadas en lo que va del mes calendario actual, sumando la
    // duración de cada evento al que el mozo realmente asistió (no solo
    // anotado). La duración se calcula en JS con horasDeEvento porque hay
    // que contemplar eventos que cruzan medianoche. De paso, de la misma
    // consulta sacamos "días trabajados" — fechas distintas con al menos
    // un evento asistido (si trabajó 2 eventos el mismo día, cuenta 1 día).
    const mesActual = hoy.slice(0, 7); // 'YYYY-MM'
    const eventosDelMesRaw = await db.all2(`
      SELECT i.usuario_id, e.fecha::text AS fecha, e.hora_desde, e.hora_hasta
      FROM eventos_ayb_inscripciones i
      JOIN eventos_ayb e ON e.id = i.evento_id
      WHERE i.usuario_id = ANY($1) AND i.asistio = true
        AND to_char(e.fecha, 'YYYY-MM') = $2
    `, [idsAyb, mesActual]);
    const diasTrabajadosSets = {};
    eventosDelMesRaw.forEach(ev => {
      horasMesMap[ev.usuario_id] = (horasMesMap[ev.usuario_id] || 0) + horasDeEvento(ev.hora_desde, ev.hora_hasta);
      if (!diasTrabajadosSets[ev.usuario_id]) diasTrabajadosSets[ev.usuario_id] = new Set();
      diasTrabajadosSets[ev.usuario_id].add(ev.fecha);
    });
    Object.keys(diasTrabajadosSets).forEach(uid => {
      diasTrabajadosMap[uid] = diasTrabajadosSets[uid].size;
    });
  }

  // Mismo cálculo de "horas del mes" para Cocina, pero a partir de lo que
  // cada admin tipeó en la grilla de horarios_semanales (texto libre por
  // día) en vez de eventos con asistencia real. Los días con un ESTADO
  // (OFF/VAC/RECOFF/etc.) no suman horas — no son horario trabajado.
  const idsCocina = personal.filter(p => p.departamento !== 'ayb').map(p => p.id);
  const horasMesCocinaMap = {};
  if (idsCocina.length) {
    const mesActual = hoy.slice(0, 7);
    const semanalMesRaw = await db.all2(`
      SELECT usuario_id, valor
      FROM horarios_semanales
      WHERE usuario_id = ANY($1) AND to_char(fecha, 'YYYY-MM') = $2
    `, [idsCocina, mesActual]);
    semanalMesRaw.forEach(h => {
      if (ESTADOS.includes(String(h.valor).toUpperCase())) return; // día libre/ausencia, no suma
      const horas = horasDesdeTexto(h.valor);
      if (horas !== null) horasMesCocinaMap[h.usuario_id] = (horasMesCocinaMap[h.usuario_id] || 0) + horas;
    });
  }

  const hoyMs = new Date(hoy + 'T00:00:00').getTime();
  personal.forEach(p => {
    p.eventos_trabajados = trabajadosMap[p.id] || 0;
    p.dias_trabajados_mes = diasTrabajadosMap[p.id] || 0;
    p.horas_mes_actual = p.departamento === 'ayb'
      ? Math.round((horasMesMap[p.id] || 0) * 10) / 10
      : Math.round((horasMesCocinaMap[p.id] || 0) * 10) / 10;
    p.dias_para_vencer_mozo = null;
    p.fecha_vencimiento_mozo = null;
    if (p.departamento === 'ayb' && p.modalidad === 'Eventual' && p.fecha_alta) {
      const alta = new Date(p.fecha_alta + 'T00:00:00');
      const vencimiento = new Date(alta);
      vencimiento.setMonth(vencimiento.getMonth() + MESES_LIMITE_MOZO_EVENTUAL);
      p.fecha_vencimiento_mozo = vencimiento.toISOString().split('T')[0];
      p.dias_para_vencer_mozo = Math.round((vencimiento.getTime() - hoyMs) / 86400000);
    }
  });
  const mozosVencidos = personal.filter(p => p.dias_para_vencer_mozo !== null && p.dias_para_vencer_mozo < 0);
  const mozosPorVencer = personal.filter(p => p.dias_para_vencer_mozo !== null && p.dias_para_vencer_mozo >= 0 && p.dias_para_vencer_mozo <= DIAS_ALERTA_VENCIMIENTO_MOZO);

  const msg     = req.query.msg || null;
  const esAdmin = (req.session.usuario.rol || '').toLowerCase() === 'admin';
  const cargadosMozos    = parseInt(req.query.cargados) || 0;
  const duplicadosMozos  = parseInt(req.query.duplicados) || 0;

  // Feriados: solo un marcador visual en el calendario, no toca horarios de nadie.
  const feriados = await db.all2('SELECT fecha::text, nombre FROM feriados ORDER BY fecha');

  // Horarios del rango seleccionado
  const semanalRaw = await db.all2(`
    SELECT usuario_id, fecha::text, valor, sector_dia
    FROM horarios_semanales
    WHERE fecha >= $1 AND fecha <= $2
  `, [dias[0], dias[dias.length - 1]]);

  const horarioSemanalMap = {};
  const sectorDiaMap = {};
  semanalRaw.forEach(h => {
    if (!horarioSemanalMap[h.usuario_id]) horarioSemanalMap[h.usuario_id] = {};
    horarioSemanalMap[h.usuario_id][h.fecha] = h.valor;
    if (h.sector_dia) {
      if (!sectorDiaMap[h.usuario_id]) sectorDiaMap[h.usuario_id] = {};
      sectorDiaMap[h.usuario_id][h.fecha] = h.sector_dia;
    }
  });

  // Disponibilidad de los mozos de AYB para el mismo rango — de acá sale lo
  // que se pinta en su columna de la tabla. Es de solo lectura en esta
  // pantalla: cada mozo la carga desde Horarios, no se edita desde acá.
  const dispRaw = await db.all2(`
    SELECT usuario_id, fecha::text, disponible, hora_desde, hora_hasta
    FROM disponibilidad
    WHERE fecha >= $1 AND fecha <= $2
  `, [dias[0], dias[dias.length - 1]]);
  const dispMap = {};
  dispRaw.forEach(d => {
    if (!dispMap[d.usuario_id]) dispMap[d.usuario_id] = {};
    dispMap[d.usuario_id][d.fecha] = d;
  });

  // Navegación de período — se usa en el header simplificado que ve AYB en
  // vez del selector de calendario (ese es un concepto de Cocina: elegís
  // un rango para cargar estados a mano, cosa que AYB ya no hace acá).
  const duracionRango = dias.length;
  const rangoAnterior = { inicio: sumarDias(inicio, -duracionRango), fin: sumarDias(fin, -duracionRango) };
  const rangoSiguiente = { inicio: sumarDias(inicio, duracionRango), fin: sumarDias(fin, duracionRango) };

  res.render('personal', {
    personal, puestos: PUESTOS, roles: ROLES, sectores: sectoresVisibles,
    modalidadesAyb: MODALIDADES_AYB, misDepto,
    ESTADOS, msg, esAdmin, hoy, inicio, fin, dias, horarioSemanalMap, sectorDiaMap,
    feriados, cargadosMozos, duplicadosMozos, dispMap, rangoAnterior, rangoSiguiente,
    mozosVencidos, mozosPorVencer, mesFiltro,
    // compatibilidad con campos viejos
    horarioMap: {}
  });
});

// ── Feriados: marcador visual en el calendario, vía AJAX ──
// Solo pinta el día en el calendario — no toca los horarios de ningún empleado.
router.post('/feriados', loginRequerido, async (req, res) => {
  const { fecha, nombre } = req.body;
  try {
    if (!fecha || !nombre || !nombre.trim()) {
      return res.json({ ok: false, error: 'Falta la fecha o el nombre del feriado.' });
    }
    await db.run2(
      `INSERT INTO feriados (fecha, nombre) VALUES ($1,$2)
       ON CONFLICT (fecha) DO UPDATE SET nombre=$2`,
      [fecha, nombre.trim()]
    );
    res.json({ ok: true, fecha, nombre: nombre.trim() });
  } catch (e) {
    console.error('Error guardando feriado:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/feriados/:fecha/eliminar', loginRequerido, async (req, res) => {
  try {
    await db.run2('DELETE FROM feriados WHERE fecha=$1', [req.params.fecha]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error eliminando feriado:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── POST /asignar-semana-completa ──────────────────────
// Guarda un valor por cada día del rango: puede ser una hora de entrada o un estado especial
router.post('/asignar-semana-completa', loginRequerido, async (req, res) => {
  const { usuario_id, inicio, fin, valores, sectoresDia } = req.body;
  try {
    const dias = getDiasRango(inicio, fin || inicio);
    const mapa = valores && typeof valores === 'object' ? valores : {};
    const mapaSectores = sectoresDia && typeof sectoresDia === 'object' ? sectoresDia : {};

    for (const dia of dias) {
      const crudo = mapa[dia];
      if (!crudo || String(crudo).trim() === '') {
        // Sin valor para ese día: borrar lo que hubiera
        await db.run2('DELETE FROM horarios_semanales WHERE usuario_id=$1 AND fecha=$2',
          [parseInt(usuario_id), dia]);
        continue;
      }
      const texto = String(crudo).trim();
      // Si coincide con un estado conocido (VAC, OFF, etc.) lo normalizamos a mayúsculas;
      // si es una hora u otro texto libre, lo dejamos tal cual lo escribió el usuario.
      const valor = ESTADOS.includes(texto.toUpperCase()) ? texto.toUpperCase() : texto;
      const sectorDia = (mapaSectores[dia] || '').trim() || null;
      await db.run2(`
        INSERT INTO horarios_semanales (usuario_id, fecha, valor, sector_dia)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (usuario_id, fecha) DO UPDATE SET valor = $3, sector_dia = $4
      `, [parseInt(usuario_id), dia, valor, sectorDia]);
    }
    res.json({ ok: true, recoff_pendiente: await calcularRecoffPendiente(usuario_id) });
  } catch(e) {
    console.error('Error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// Suma o resta días al saldo ADEUDADO de un empleado (carga manual)
router.post('/:id/recoff-ajustar', loginRequerido, async (req, res) => {
  try {
    const delta = parseInt(req.body.delta) || 0;
    const usuario_id = req.params.id;

    // El botón +/- cambia directamente el número que se VE (el pendiente),
    // sin importar cuántos RECOFF ya tenga puestos en la grilla.
    const usados = await db.get2(
      "SELECT COUNT(*)::int AS c FROM horarios_semanales WHERE usuario_id=$1 AND UPPER(valor)='RECOFF'",
      [usuario_id]
    );
    const filaActual = await db.get2('SELECT recoff_adeudado FROM usuarios WHERE id=$1', [usuario_id]);
    const pendienteActual = (filaActual?.recoff_adeudado || 0) - (usados?.c || 0);
    const pendienteNuevo = Math.max(pendienteActual + delta, 0);
    const nuevoAdeudado = pendienteNuevo + (usados?.c || 0);

    await db.run2('UPDATE usuarios SET recoff_adeudado = $1 WHERE id=$2', [nuevoAdeudado, usuario_id]);
    res.json({ ok: true, recoff_pendiente: pendienteNuevo });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Pendiente real = días adeudados (cargados a mano) - RECOFF que ya tiene puestos en la grilla.
// Se recalcula siempre en vivo, así no importa en qué orden se haya cargado cada cosa.
async function calcularRecoffPendiente(usuario_id) {
  const fila = await db.get2('SELECT recoff_adeudado FROM usuarios WHERE id=$1', [usuario_id]);
  const usados = await db.get2(
    "SELECT COUNT(*)::int AS c FROM horarios_semanales WHERE usuario_id=$1 AND UPPER(valor)='RECOFF'",
    [usuario_id]
  );
  return (fila?.recoff_adeudado || 0) - (usados?.c || 0);
}

// ── POST /asignar-semana (compatibilidad) ──────────────
router.post('/asignar-semana', loginRequerido, async (req, res) => {
  const { usuario_id, valor } = req.body;
  try {
    const hoy   = new Date().toISOString().split('T')[0];
    const lunes = getLunes(hoy);
    const dias  = getDiasSemana(lunes);
    for (const dia of dias) {
      if (!valor || valor.trim() === '') {
        await db.run2('DELETE FROM horarios_semanales WHERE usuario_id=$1 AND fecha=$2', [parseInt(usuario_id), dia]);
      } else {
        await db.run2(`
          INSERT INTO horarios_semanales (usuario_id, fecha, valor)
          VALUES ($1, $2, $3)
          ON CONFLICT (usuario_id, fecha) DO UPDATE SET valor = $3
        `, [parseInt(usuario_id), dia, valor.trim().toUpperCase()]);
      }
    }
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── POST /nuevo ────────────────────────────────────────
// ── Importar mozos por CSV (CUIL, Nombre, Modalidad) ────
// Pensado para cargar de una el padrón que hoy vive en la planilla de
// Excel. Duplicados por CUIL se saltean (no pisan al que ya está).
function normalizarEncabezadoMozo(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}
function parsearCsvMozos(rutaArchivo) {
  const contenido = fs.readFileSync(rutaArchivo, 'utf8');
  const lineas = contenido.split(/\r?\n/).filter(l => l.trim());
  if (lineas.length === 0) throw new Error('El archivo está vacío.');

  const cantComas = (lineas[0].match(/,/g) || []).length;
  const cantPuntoYComa = (lineas[0].match(/;/g) || []).length;
  const separador = cantPuntoYComa > cantComas ? ';' : ',';
  const partir = (l) => l.split(separador).map(c => c.trim().replace(/^"|"$/g, ''));

  const encabezados = partir(lineas[0]).map(normalizarEncabezadoMozo);
  const COLS = {
    cuil:      ['cuil', 'cuil/dni', 'dni', 'documento'],
    nombre:    ['nombre', 'nombre y apellido', 'apellido y nombre', 'empleado'],
    modalidad: ['modalidad', 'tipo', 'categoria'],
  };
  const buscar = (variantes) => { for (const v of variantes) { const i = encabezados.indexOf(v); if (i !== -1) return i; } return -1; };
  const idx = { cuil: buscar(COLS.cuil), nombre: buscar(COLS.nombre), modalidad: buscar(COLS.modalidad) };
  if (idx.nombre === -1) throw new Error('El archivo tiene que tener al menos una columna de nombre (ej: "Nombre").');

  const filas = [];
  for (let i = 1; i < lineas.length; i++) {
    const campos = partir(lineas[i]);
    const nombre = (campos[idx.nombre] || '').trim();
    if (!nombre) continue;
    const cuil = idx.cuil !== -1 ? (campos[idx.cuil] || '').trim() : '';
    const modalidadCruda = idx.modalidad !== -1 ? normalizarEncabezadoMozo(campos[idx.modalidad]) : '';
    const modalidad = MODALIDADES_AYB.find(m => m.toLowerCase() === modalidadCruda) || null;
    filas.push({ nombre, cuil, modalidad });
  }
  return filas;
}

router.post('/importar-mozos', loginRequerido, uploadMozos.single('archivo'), async (req, res) => {
  if (!req.file) return res.redirect('/personal?msg=' + encodeURIComponent('No se subió ningún archivo.'));
  try {
    const filas = parsearCsvMozos(req.file.path);
    let cargados = 0, duplicados = 0;
    for (const f of filas) {
      if (f.cuil) {
        const existe = await db.get2('SELECT id FROM usuarios WHERE legajo=$1', [f.cuil]);
        if (existe) { duplicados++; continue; }
      }
      const hash = bcrypt.hashSync('Hilton2026!', 10);
      await db.run2(
        'INSERT INTO usuarios (nombre, legajo, puesto, rol, password, departamento, modalidad, fecha_alta) VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE)',
        [f.nombre, f.cuil || null, 'Mozo', 'empleado', hash, 'ayb', f.modalidad]
      );
      cargados++;
    }
    fs.unlink(req.file.path, () => {});
    res.redirect(`/personal?msg=mozos_importados&cargados=${cargados}&duplicados=${duplicados}`);
  } catch (e) {
    console.error('Error importando mozos:', e.message);
    res.redirect('/personal?msg=' + encodeURIComponent('Error al importar: ' + e.message));
  }
});

// ── Importar mozos con foto de planilla (Gemini) ────────
// Mismo patrón que /croutons/remito: la foto nunca se carga directo a la
// base — Gemini la lee, y el resultado queda pendiente en la sesión para
// que el encargado lo revise y corrija en /importar-mozos-foto/revisar
// antes de confirmar.
router.post('/importar-mozos-foto', uploadMozosFoto.single('foto'), async (req, res) => {
  if (!req.file) return res.redirect('/personal?msg=' + encodeURIComponent('No se recibió ninguna imagen.'));

  try {
    const { tipoDocumento, items } = await analizarPlanillaMozos(req.file.path);
    fs.unlink(req.file.path, () => {});

    if (tipoDocumento === 'otro') {
      return res.redirect('/personal?msg=' + encodeURIComponent(
        'No se reconoció la imagen como una planilla o lista de personal.'
      ));
    }
    if (items.length === 0) {
      return res.redirect('/personal?msg=' + encodeURIComponent(
        'No se pudo leer ningún nombre en la imagen. Probá con otra foto o cargalos a mano.'
      ));
    }

    req.session.mozosFotoPendiente = items;
    res.redirect('/personal/importar-mozos-foto/revisar');
  } catch (e) {
    console.error('Error analizando planilla de mozos con Gemini:', e.message, e.cause || '');
    res.redirect('/personal?msg=' + encodeURIComponent(mensajeErrorGemini(e)));
  }
});

router.get('/importar-mozos-foto/revisar', async (req, res) => {
  const items = req.session.mozosFotoPendiente || [];
  res.render('personal_importar_mozos_revisar', { items, modalidadesAyb: MODALIDADES_AYB });
});

router.post('/importar-mozos-foto/aplicar', async (req, res) => {
  const items = req.session.mozosFotoPendiente || [];
  let seleccionados = req.body.aplicar || [];
  if (!Array.isArray(seleccionados)) seleccionados = [seleccionados];
  const idxsSeleccionados = seleccionados.map(s => parseInt(s));

  const nombres = req.body.nombre || {};
  const cuils = req.body.cuil || {};
  const modalidades = req.body.modalidad || {};

  let cargados = 0, duplicados = 0, omitidos = 0;

  try {
    for (const idx of idxsSeleccionados) {
      if (!items[idx]) continue;

      const nombre = (nombres[idx] || '').trim();
      const cuil = (cuils[idx] || '').trim();
      const modalidad = MODALIDADES_AYB.includes(modalidades[idx]) ? modalidades[idx] : 'Eventual';

      if (!nombre) { omitidos++; continue; }

      if (cuil) {
        const existe = await db.get2('SELECT id FROM usuarios WHERE legajo=$1', [cuil]);
        if (existe) { duplicados++; continue; }
      }

      const hash = bcrypt.hashSync('Hilton2026!', 10);
      await db.run2(
        'INSERT INTO usuarios (nombre, legajo, puesto, rol, password, departamento, modalidad, fecha_alta) VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE)',
        [nombre, cuil || null, 'Mozo', 'empleado', hash, 'ayb', modalidad]
      );
      cargados++;
    }
    delete req.session.mozosFotoPendiente;
    res.redirect(`/personal?msg=mozos_importados&cargados=${cargados}&duplicados=${duplicados}`);
  } catch (e) {
    console.error('Error aplicando mozos de foto:', e.message);
    res.redirect('/personal?msg=' + encodeURIComponent('Error al cargar: ' + e.message));
  }
});

router.post('/nuevo', loginRequerido, async (req, res) => {
  try {
    const nombre   = String(req.body.nombre || '').trim();
    const email    = req.body.email ? String(req.body.email).toLowerCase().trim() : null;
    const rol      = String(req.body.rol || 'empleado');
    const password = String(req.body.password || 'Hilton2026!');
    const hash     = bcrypt.hashSync(password, 10);

    // El formulario de alta manda "sector" (Cocina) o "modalidad" (AYB —
    // mozos), nunca los dos. Un mozo se guarda con departamento='ayb' fijo,
    // el CUIL en "legajo" (así se puede loguear sin email) y su modalidad.
    let legajo, puesto, departamento, modalidad, fechaAlta;
    if (req.body.modalidad) {
      legajo       = req.body.cuil ? String(req.body.cuil).trim() : null;
      puesto       = 'Mozo';
      departamento = 'ayb';
      modalidad    = String(req.body.modalidad);
      // Si no la especifican a mano, asumimos que el alta es hoy.
      fechaAlta    = req.body.fecha_alta ? String(req.body.fecha_alta).trim() : new Date().toISOString().split('T')[0];
    } else {
      legajo       = req.body.legajo ? String(req.body.legajo).trim() : null;
      puesto       = String(req.body.puesto || 'Cocinero');
      departamento = req.body.sector || null;
      modalidad    = null;
      fechaAlta    = null;
    }
    const celular = req.body.celular ? String(req.body.celular).trim() : null;

    await db.run2(
      'INSERT INTO usuarios (nombre, email, legajo, puesto, rol, password, departamento, modalidad, fecha_alta, celular) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [nombre, email, legajo, puesto, rol, hash, departamento, modalidad, fechaAlta, celular]
    );
  } catch(e) {
    console.error('Error creando usuario:', e.message);
  }
  res.redirect('/personal');
});

// ── POST /editar ───────────────────────────────────────
router.post('/editar', loginRequerido, async (req, res) => {
  try {
    const { id, nombre, legajo, puesto, rol, sector, cuil, modalidad, fecha_alta, celular } = req.body;
    const email = req.body.email ? String(req.body.email).toLowerCase().trim() : null;

    if (modalidad) {
      await db.run2(
        'UPDATE usuarios SET nombre=$1, email=$2, legajo=$3, puesto=$4, rol=$5, departamento=$6, modalidad=$7, fecha_alta=$8, celular=$9 WHERE id=$10',
        [String(nombre).trim(), email, cuil ? String(cuil).trim() : null, 'Mozo', rol, 'ayb', String(modalidad), fecha_alta ? String(fecha_alta).trim() : null, celular ? String(celular).trim() : null, parseInt(id)]
      );
    } else {
      await db.run2(
        'UPDATE usuarios SET nombre=$1, email=$2, legajo=$3, puesto=$4, rol=$5, departamento=$6, modalidad=NULL WHERE id=$7',
        [String(nombre).trim(), email, legajo || null, puesto, rol, sector || null, parseInt(id)]
      );
    }
    res.redirect('/personal?msg=empleado_editado');
  } catch(e) {
    console.error('Error editando usuario:', e.message);
    res.redirect('/personal?msg=' + encodeURIComponent('Error al editar empleado.'));
  }
});

// Detalle de horas trabajadas de un mozo: en qué eventos estuvo presente
// de verdad (asistio=true), cuántas horas hizo en cada uno, agrupado por
// mes con subtotal, más el total general. Pensado para armar los pagos.
router.get('/:id/horas', loginRequerido, async (req, res) => {
  const usuarioId = parseInt(req.params.id);
  const yo = req.session.usuario;
  if ((yo.rol || '').toLowerCase() !== 'admin' && yo.id !== usuarioId) {
    return res.status(403).send('No autorizado.');
  }
  const empleado = await db.get2('SELECT id, nombre, legajo, modalidad, fecha_alta::text FROM usuarios WHERE id=$1', [usuarioId]);
  if (!empleado) return res.status(404).send('Empleado no encontrado.');

  const eventosRaw = await db.all2(`
    SELECT e.id, e.nombre, e.fecha::text, e.hora_desde, e.hora_hasta
    FROM eventos_ayb_inscripciones i
    JOIN eventos_ayb e ON e.id = i.evento_id
    WHERE i.usuario_id = $1 AND i.asistio = true
    ORDER BY e.fecha DESC, e.hora_desde DESC
  `, [usuarioId]);

  const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const gruposPorMes = {};
  let totalGeneral = 0;
  eventosRaw.forEach(ev => {
    const horas = Math.round(horasDeEvento(ev.hora_desde, ev.hora_hasta) * 10) / 10;
    const [anio, mes] = ev.fecha.split('-');
    const claveMes = `${anio}-${mes}`;
    if (!gruposPorMes[claveMes]) {
      gruposPorMes[claveMes] = { etiqueta: `${MESES[parseInt(mes, 10) - 1]} ${anio}`, eventos: [], subtotal: 0 };
    }
    gruposPorMes[claveMes].eventos.push({ ...ev, horas });
    gruposPorMes[claveMes].subtotal += horas;
    totalGeneral += horas;
  });
  const meses = Object.keys(gruposPorMes).sort().reverse().map(k => gruposPorMes[k]);
  meses.forEach(m => { m.subtotal = Math.round(m.subtotal * 10) / 10; });

  res.render('personal_horas', {
    empleado, meses, totalGeneral: Math.round(totalGeneral * 10) / 10, path: 'personal'
  });
});

router.post('/:id/eliminar', loginRequerido, async (req, res) => {
  await db.run2('UPDATE usuarios SET activo=0 WHERE id=$1', [req.params.id]);
  res.redirect('/personal');
});

router.post('/:id/activar', loginRequerido, async (req, res) => {
  await db.run2('UPDATE usuarios SET activo=1 WHERE id=$1', [req.params.id]);
  res.redirect('/personal');
});

router.post('/:id/reset-password', loginRequerido, async (req, res) => {
  const password_nuevo = String(req.body.password_nuevo || '');
  if (password_nuevo.length < 6) return res.redirect('/personal');
  const hash = bcrypt.hashSync(password_nuevo, 10);
  await db.run2('UPDATE usuarios SET password=$1 WHERE id=$2', [hash, req.params.id]);
  res.redirect('/personal?msg=password_reseteada');
});

// ── Disponibilidad: calendario mensual por empleado ────
// GET trae el mapa {fecha: {disponible, hora_desde, hora_hasta}} de un mes
// puntual; POST carga/borra un día. Guardado disperso, igual que feriados:
// si "estado" llega vacío, se borra la fila (vuelve a "sin dato").
// Solo el propio empleado o un admin pueden ver/tocar esta disponibilidad —
// antes cualquier usuario logueado podía pisarle la disponibilidad a
// cualquier otro con solo cambiar el :id en la URL (no importaba mientras
// esto lo usaba nada más que el menú de admin, pero ahora que cada mozo
// carga la suya con su propio login hace falta esta verificación).
function puedeVerDisponibilidad(req) {
  const yo = req.session.usuario;
  return (yo.rol || '').toLowerCase() === 'admin' || yo.id === parseInt(req.params.id);
}

router.get('/:id/disponibilidad', loginRequerido, async (req, res) => {
  try {
    if (!puedeVerDisponibilidad(req)) return res.status(403).json({ ok: false, error: 'No autorizado.' });
    const usuario_id = parseInt(req.params.id);
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : null;
    if (!usuario_id || !mes) return res.json({ ok: false, error: 'Falta el mes (YYYY-MM).' });

    const filas = await db.all2(
      `SELECT fecha::text, disponible, hora_desde, hora_hasta FROM disponibilidad
       WHERE usuario_id=$1 AND to_char(fecha,'YYYY-MM')=$2`,
      [usuario_id, mes]
    );
    const dias = {};
    filas.forEach(f => {
      dias[f.fecha] = { disponible: f.disponible, hora_desde: f.hora_desde || '', hora_hasta: f.hora_hasta || '' };
    });
    res.json({ ok: true, dias });
  } catch (e) {
    console.error('Error cargando disponibilidad:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/:id/disponibilidad', loginRequerido, async (req, res) => {
  try {
    if (!puedeVerDisponibilidad(req)) return res.status(403).json({ ok: false, error: 'No autorizado.' });
    const usuario_id = parseInt(req.params.id);
    // estado: 'disponible' | 'no_disponible' | '' (sin dato)
    // hora_desde/hora_hasta solo aplican cuando estado='disponible'. Si
    // hora_hasta viene vacío significa "a partir de esa hora, sin límite".
    const { fecha, estado } = req.body;
    const hora_desde = req.body.hora_desde ? String(req.body.hora_desde).trim() : null;
    const hora_hasta = req.body.hora_hasta ? String(req.body.hora_hasta).trim() : null;
    if (!usuario_id || !fecha) return res.json({ ok: false, error: 'Faltan datos.' });

    if (!estado) {
      await db.run2('DELETE FROM disponibilidad WHERE usuario_id=$1 AND fecha=$2', [usuario_id, fecha]);
      return res.json({ ok: true, fecha, estado: null });
    }

    const disponible = estado === 'disponible';
    if (disponible && !hora_desde) {
      return res.json({ ok: false, error: 'Falta indicar desde qué hora está disponible.' });
    }
    await db.run2(
      `INSERT INTO disponibilidad (usuario_id, fecha, disponible, hora_desde, hora_hasta) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (usuario_id, fecha) DO UPDATE SET disponible=$3, hora_desde=$4, hora_hasta=$5`,
      [usuario_id, fecha, disponible, disponible ? hora_desde : null, disponible ? hora_hasta : null]
    );
    res.json({ ok: true, fecha, estado, disponible, hora_desde: disponible ? hora_desde : null, hora_hasta: disponible ? hora_hasta : null });
  } catch (e) {
    console.error('Error guardando disponibilidad:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
