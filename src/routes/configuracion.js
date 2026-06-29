const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');

// Solo admins
function soloAdmin(req, res, next) {
  if (req.session.usuario?.rol !== 'admin') return res.redirect('/inicio');
  next();
}

const DEPTOS = ['cocina','ayb','compras','finanzas','sistema'];
const SECTORES = ['Supervisores','Comis de Recepción','Panadería','Pastelería AM','Pastelería PM','Faro AM','Faro PM','Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'];

router.get('/', loginRequerido, soloAdmin, async (req, res) => {
  const SECTORES_COCINA = ['Supervisores','Comis de Recepción','Panadería','Pastelería AM','Pastelería PM','Faro AM','Faro PM','Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'];
    const usuarios = await db.all2(`
      SELECT id, nombre, email, rol, departamento, activo,
            creado_en::text as creado_en
      FROM usuarios
      WHERE departamento NOT IN ('Supervisores','Comis de Recepción','Panadería','Pastelería AM','Pastelería PM','Faro AM','Faro PM','Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D')
      OR departamento IS NULL
      ORDER BY creado_en DESC
    `);
  const msg = req.query.msg || null;
  res.render('configuracion', { usuarios, DEPTOS, SECTORES, msg, path: 'configuracion' });
});

// Cambiar rol
router.post('/usuario/:id/rol', loginRequerido, soloAdmin, async (req, res) => {
  await db.run2('UPDATE usuarios SET rol=$1 WHERE id=$2', [req.body.rol, req.params.id]);
  res.redirect('/configuracion?msg=rol_actualizado');
});

// Cambiar departamento
router.post('/usuario/:id/departamento', loginRequerido, soloAdmin, async (req, res) => {
  await db.run2('UPDATE usuarios SET departamento=$1 WHERE id=$2', [req.body.departamento, req.params.id]);
  res.redirect('/configuracion?msg=depto_actualizado');
});

// Activar/desactivar
router.post('/usuario/:id/activar', loginRequerido, soloAdmin, async (req, res) => {
  await db.run2('UPDATE usuarios SET activo=1 WHERE id=$1', [req.params.id]);
  res.redirect('/configuracion?msg=usuario_activado');
});

router.post('/usuario/:id/desactivar', loginRequerido, soloAdmin, async (req, res) => {
  await db.run2('UPDATE usuarios SET activo=0 WHERE id=$1', [req.params.id]);
  res.redirect('/configuracion?msg=usuario_desactivado');
});

// Eliminar
router.post('/usuario/:id/eliminar', loginRequerido, soloAdmin, async (req, res) => {
  await db.run2('DELETE FROM usuarios WHERE id=$1', [req.params.id]);
  res.redirect('/configuracion?msg=usuario_eliminado');
});

module.exports = router;
