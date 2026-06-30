const express = require('express');
const router = express.Router();
const db = require('../db/database');
const bcrypt = require('bcryptjs');
const { loginRequerido } = require('./middleware');

const PUESTOS = ['Chef','Subchef','Encargado de cocina','Cocinero','Ayudante de cocina','Pastelero','Panadero','Mozo','Sommelier','Limpieza','Administrativo'];
const ROLES   = ['empleado','supervisor','admin'];
const SECTORES = ['Supervisores','Comis de Recepción','Panadería','Pastelería AM','Pastelería PM','Faro AM','Faro PM','Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'];
const SECTORES_COCINA = SECTORES;

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

// ── GET / ──────────────────────────────────────────────
router.get('/', loginRequerido, async (req, res) => {
  const personal = await db.all2(`
    SELECT id,nombre,email,legajo,puesto,rol,activo,departamento,creado_en
    FROM usuarios
    WHERE departamento = ANY($1)
    ORDER BY nombre
  `, [SECTORES_COCINA]);

  const msg     = req.query.msg || null;
  const esAdmin = req.session.usuario.rol === 'admin';
  const hoy     = new Date().toISOString().split('T')[0];

  const horariosHoy = await db.all2(
    'SELECT usuario_id, hora_inicio, seccion FROM horarios WHERE fecha=$1', [hoy]
  );
  const horarioMap = {};
  horariosHoy.forEach(h => {
    horarioMap[h.usuario_id] = { hora: h.hora_inicio, seccion: h.seccion };
  });

  // Horario semanal actual
  const lunes = getLunes(hoy);
  const semanalRaw = await db.all2(
    'SELECT usuario_id, valor FROM horarios_semanales WHERE fecha=$1', [lunes]
  );
  const horarioSemanalMap = {};
  semanalRaw.forEach(h => { horarioSemanalMap[h.usuario_id] = h.valor; });

  res.render('personal', { personal, puestos: PUESTOS, roles: ROLES, sectores: SECTORES, msg, esAdmin, horarioMap, hoy, horarioSemanalMap });
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

// ── POST /asignar-semana ───────────────────────────────
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
    console.error('Error asignando semana:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── POST /asignar-turno ────────────────────────────────
router.post('/asignar-turno', loginRequerido, async (req, res) => {
  try {
    const { usuario_id, fecha, hora_entrada, seccion } = req.body;
    const hora = parseInt((hora_entrada || '08:00').split(':')[0]);
    let turno, hora_inicio, hora_fin;
    if (hora >= 6 && hora < 14) {
      turno = 'manana'; hora_inicio = '06:00'; hora_fin = '14:00';
    } else if (hora >= 14 && hora < 22) {
      turno = 'tarde';  hora_inicio = '14:00'; hora_fin = '22:00';
    } else {
      turno = 'noche';  hora_inicio = '22:00'; hora_fin = '06:00';
    }
    const existe = await db.get2(
      'SELECT id FROM horarios WHERE fecha=$1 AND usuario_id=$2 AND turno=$3',
      [fecha, parseInt(usuario_id), turno]
    );
    if (existe) {
      await db.run2(
        'UPDATE horarios SET hora_inicio=$1, hora_fin=$2, seccion=$3 WHERE id=$4',
        [hora_entrada, hora_fin, seccion || null, existe.id]
      );
    } else {
      await db.run2(
        'INSERT INTO horarios (fecha, turno, hora_inicio, hora_fin, usuario_id, seccion, estado) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [fecha, turno, hora_entrada, hora_fin, parseInt(usuario_id), seccion || null, 'asignado']
      );
    }
    res.redirect('/personal?msg=turno_asignado');
  } catch(e) {
    console.error('Error asignando turno:', e.message);
    res.redirect('/personal?msg=' + encodeURIComponent('Error al asignar turno.'));
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
