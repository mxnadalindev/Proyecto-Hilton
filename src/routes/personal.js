const express = require('express');
const router = express.Router();
const db = require('../db/database');
const bcrypt = require('bcryptjs');
const { loginRequerido } = require('./middleware');

const PUESTOS = ['Chef','Subchef','Encargado de cocina','Cocinero','Ayudante de cocina','Pastelero','Panadero','Mozo','Sommelier','Limpieza','Administrativo'];
const ROLES   = ['empleado','supervisor','admin'];
const SECTORES = ['Supervisores','Comis de Recepción','Panadería','Pastelería AM','Pastelería PM','Faro AM','Faro PM','Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'];
const ESTADOS = ['OFF','VAC','RECOFF','FERIADO','LICENCIA','CUMPLE','MUDANZA','FRANCO'];

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

  const personal = await db.all2(`
    SELECT id,nombre,email,legajo,puesto,rol,activo,departamento,creado_en,recoff_adeudado
    FROM usuarios
    WHERE departamento = ANY($1)
    ORDER BY departamento, nombre
  `, [SECTORES]);

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

  const msg     = req.query.msg || null;
  const esAdmin = req.session.usuario.rol === 'admin';

  // Horarios del rango seleccionado
  const semanalRaw = await db.all2(`
    SELECT usuario_id, fecha::text, valor
    FROM horarios_semanales
    WHERE fecha >= $1 AND fecha <= $2
  `, [dias[0], dias[dias.length - 1]]);

  const horarioSemanalMap = {};
  semanalRaw.forEach(h => {
    if (!horarioSemanalMap[h.usuario_id]) horarioSemanalMap[h.usuario_id] = {};
    horarioSemanalMap[h.usuario_id][h.fecha] = h.valor;
  });

  res.render('personal', {
    personal, puestos: PUESTOS, roles: ROLES, sectores: SECTORES,
    ESTADOS, msg, esAdmin, hoy, inicio, fin, dias, horarioSemanalMap,
    // compatibilidad con campos viejos
    horarioMap: {}
  });
});

// ── POST /asignar-semana-completa ──────────────────────
// Guarda un valor por cada día del rango: puede ser una hora de entrada o un estado especial
router.post('/asignar-semana-completa', loginRequerido, async (req, res) => {
  const { usuario_id, inicio, fin, valores } = req.body;
  try {
    const dias = getDiasRango(inicio, fin || inicio);
    const mapa = valores && typeof valores === 'object' ? valores : {};

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
      await db.run2(`
        INSERT INTO horarios_semanales (usuario_id, fecha, valor)
        VALUES ($1, $2, $3)
        ON CONFLICT (usuario_id, fecha) DO UPDATE SET valor = $3
      `, [parseInt(usuario_id), dia, valor]);
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
router.post('/nuevo', loginRequerido, async (req, res) => {
  try {
    const nombre   = String(req.body.nombre || '').trim();
    const email    = req.body.email ? String(req.body.email).toLowerCase().trim() : null;
    const legajo   = req.body.legajo ? String(req.body.legajo).trim() : null;
    const puesto   = String(req.body.puesto || 'Cocinero');
    const rol      = String(req.body.rol || 'empleado');
    const sector   = req.body.sector || null;
    const password = String(req.body.password || 'Hilton2026!');
    const hash     = bcrypt.hashSync(password, 10);
    await db.run2(
      'INSERT INTO usuarios (nombre, email, legajo, puesto, rol, password, departamento) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [nombre, email, legajo, puesto, rol, hash, sector]
    );
  } catch(e) {
    console.error('Error creando usuario:', e.message);
  }
  res.redirect('/personal');
});

// ── POST /editar ───────────────────────────────────────
router.post('/editar', loginRequerido, async (req, res) => {
  try {
    const { id, nombre, legajo, puesto, rol, sector } = req.body;
    const email = req.body.email ? String(req.body.email).toLowerCase().trim() : null;
    await db.run2(
      'UPDATE usuarios SET nombre=$1, email=$2, legajo=$3, puesto=$4, rol=$5, departamento=$6 WHERE id=$7',
      [String(nombre).trim(), email, legajo || null, puesto, rol, sector || null, parseInt(id)]
    );
    res.redirect('/personal?msg=empleado_editado');
  } catch(e) {
    console.error('Error editando usuario:', e.message);
    res.redirect('/personal?msg=' + encodeURIComponent('Error al editar empleado.'));
  }
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

module.exports = router;
