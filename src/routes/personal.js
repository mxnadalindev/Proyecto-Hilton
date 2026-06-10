const express = require('express');
const router = express.Router();
const db = require('../db/database');
const bcrypt = require('bcryptjs');
const { loginRequerido } = require('./middleware');

const PUESTOS = ['Chef','Subchef','Encargado de cocina','Cocinero','Ayudante de cocina','Pastelero','Panadero','Mozo','Sommelier','Limpieza','Administrativo'];
const ROLES   = ['empleado','supervisor','admin'];

router.get('/', loginRequerido, async (req, res) => {
  const personal = await db.all2('SELECT id,nombre,email,legajo,puesto,rol,activo,creado_en FROM usuarios ORDER BY nombre');
  const msg      = req.query.msg || null;
  const esAdmin  = req.session.usuario.rol === 'admin';
  res.render('personal', { personal, puestos: PUESTOS, roles: ROLES, msg, esAdmin });
});

router.post('/nuevo', loginRequerido, async (req, res) => {
  try {
    const nombre   = String(req.body.nombre   || '').trim();
    const email    = String(req.body.email    || '').toLowerCase().trim();
    const legajo   = req.body.legajo ? String(req.body.legajo).trim() : null;
    const puesto   = String(req.body.puesto   || 'Cocinero');
    const rol      = String(req.body.rol      || 'empleado');
    const password = String(req.body.password || 'Hilton2026!');
    const hash     = bcrypt.hashSync(password, 10);
    await db.run2(
      'INSERT INTO usuarios (nombre, email, legajo, puesto, rol, password) VALUES ($1, $2, $3, $4, $5, $6)',
      [nombre, email, legajo, puesto, rol, hash]
    );
  } catch(e) {
    console.error('Error creando usuario:', e.message);
  }
  res.redirect('/personal');
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
