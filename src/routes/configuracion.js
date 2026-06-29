const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');
const { registrar } = require('./auditoria');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function soloAdmin(req, res, next) {
  if (req.session.usuario?.rol !== 'admin') return res.redirect('/inicio');
  next();
}

const DEPTOS = ['cocina','ayb','compras','finanzas','sistema'];
const SECTORES = ['Supervisores','Comis de Recepción','Panadería','Pastelería AM','Pastelería PM','Faro AM','Faro PM','Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'];
const BACKUPS_DIR = path.join(__dirname, '../../backups');

if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

function getBackups() {
  try {
    return fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.endsWith('.dump'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, f));
        return { nombre: f, size: (stat.size / 1024).toFixed(1), fecha: stat.mtime };
      })
      .sort((a, b) => b.fecha - a.fecha);
  } catch { return []; }
}

// ── GET / ──────────────────────────────────────────────
router.get('/', loginRequerido, soloAdmin, async (req, res) => {
  const usuarios = await db.all2(`
    SELECT id, nombre, email, rol, departamento, activo, creado_en::text as creado_en
    FROM usuarios
    WHERE departamento NOT IN ('Supervisores','Comis de Recepción','Panadería','Pastelería AM','Pastelería PM','Faro AM','Faro PM','Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D')
    OR departamento IS NULL
    ORDER BY creado_en DESC
  `);

  const auditoria = await db.all2(`
    SELECT id, usuario_nombre, accion, detalle, ip, creado_en::text as creado_en
    FROM auditoria ORDER BY creado_en DESC LIMIT 100
  `);

  const configRows = await db.all2('SELECT clave, valor FROM configuracion_sistema');
  const config = {};
  configRows.forEach(r => config[r.clave] = r.valor);

  const msg = req.query.msg || null;
  const backups = getBackups();
  res.render('configuracion', { usuarios, DEPTOS, SECTORES, msg, path: 'configuracion', backups, auditoria, config });
});

// ── Usuarios ──────────────────────────────────────────
router.post('/usuario/:id/rol', loginRequerido, soloAdmin, async (req, res) => {
  const u = await db.get2('SELECT nombre FROM usuarios WHERE id=$1', [req.params.id]);
  await db.run2('UPDATE usuarios SET rol=$1 WHERE id=$2', [req.body.rol, req.params.id]);
  await registrar(req, 'cambio_rol', `${u?.nombre} → ${req.body.rol}`);
  res.redirect('/configuracion?msg=rol_actualizado');
});

router.post('/usuario/:id/departamento', loginRequerido, soloAdmin, async (req, res) => {
  const u = await db.get2('SELECT nombre FROM usuarios WHERE id=$1', [req.params.id]);
  await db.run2('UPDATE usuarios SET departamento=$1 WHERE id=$2', [req.body.departamento, req.params.id]);
  await registrar(req, 'cambio_departamento', `${u?.nombre} → ${req.body.departamento}`);
  res.redirect('/configuracion?msg=depto_actualizado');
});

router.post('/usuario/:id/activar', loginRequerido, soloAdmin, async (req, res) => {
  const u = await db.get2('SELECT nombre FROM usuarios WHERE id=$1', [req.params.id]);
  await db.run2('UPDATE usuarios SET activo=1 WHERE id=$1', [req.params.id]);
  await registrar(req, 'activar_usuario', u?.nombre);
  res.redirect('/configuracion?msg=usuario_activado');
});

router.post('/usuario/:id/desactivar', loginRequerido, soloAdmin, async (req, res) => {
  const u = await db.get2('SELECT nombre FROM usuarios WHERE id=$1', [req.params.id]);
  await db.run2('UPDATE usuarios SET activo=0 WHERE id=$1', [req.params.id]);
  await registrar(req, 'desactivar_usuario', u?.nombre);
  res.redirect('/configuracion?msg=usuario_desactivado');
});

router.post('/usuario/:id/eliminar', loginRequerido, soloAdmin, async (req, res) => {
  const u = await db.get2('SELECT nombre FROM usuarios WHERE id=$1', [req.params.id]);
  await db.run2('DELETE FROM usuarios WHERE id=$1', [req.params.id]);
  await registrar(req, 'eliminar_usuario', u?.nombre);
  res.redirect('/configuracion?msg=usuario_eliminado');
});

// ── Backup ────────────────────────────────────────────
router.post('/backup/crear', loginRequerido, soloAdmin, (req, res) => {
  const fecha = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archivo = path.join(BACKUPS_DIR, `hilton_db_${fecha}.dump`);
  const pgDump = '"C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe"';
  const cmd = `${pgDump} -h localhost -p 5432 -U hilton_user -d hilton_db -F c -f "${archivo}"`;
  const env = { ...process.env, PGPASSWORD: 'hilton2026' };
  exec(cmd, { env }, async (err) => {
    if (err) { console.error('Error backup:', err.message); return res.redirect('/configuracion?msg=backup_error'); }
    await registrar(req, 'backup_creado', archivo.split('\\').pop());
    res.redirect('/configuracion?msg=backup_creado');
  });
});

router.get('/backup/descargar/:nombre', loginRequerido, soloAdmin, async (req, res) => {
  const archivo = path.join(BACKUPS_DIR, req.params.nombre);
  if (!fs.existsSync(archivo)) return res.redirect('/configuracion?msg=backup_no_encontrado');
  await registrar(req, 'backup_descargado', req.params.nombre);
  res.download(archivo);
});

router.post('/backup/eliminar/:nombre', loginRequerido, soloAdmin, async (req, res) => {
  const archivo = path.join(BACKUPS_DIR, req.params.nombre);
  try { fs.unlinkSync(archivo); } catch(e) {}
  await registrar(req, 'backup_eliminado', req.params.nombre);
  res.redirect('/configuracion?msg=backup_eliminado');
});

router.post('/backup/restaurar/:nombre', loginRequerido, soloAdmin, async (req, res) => {
  const archivo = path.join(BACKUPS_DIR, req.params.nombre);
  if (!fs.existsSync(archivo)) return res.redirect('/configuracion?msg=backup_no_encontrado');
  const pgRestore = '"C:\\Program Files\\PostgreSQL\\18\\bin\\pg_restore.exe"';
  const cmd = `${pgRestore} -h localhost -p 5432 -U hilton_user -d hilton_db --clean "${archivo}"`;
  const env = { ...process.env, PGPASSWORD: 'hilton2026' };
  exec(cmd, { env }, async (err) => {
    if (err) console.error('Advertencia restauración:', err.message);
    await registrar(req, 'backup_restaurado', req.params.nombre);
    res.redirect('/configuracion?msg=backup_restaurado');
  });
});

// ── Seguridad ─────────────────────────────────────────
router.post('/seguridad', loginRequerido, soloAdmin, async (req, res) => {
  const { max_intentos_login, tiempo_bloqueo_min, sesion_horas, forzar_cambio_password } = req.body;
  const valores = {
    max_intentos_login: parseInt(max_intentos_login) || 5,
    tiempo_bloqueo_min: parseInt(tiempo_bloqueo_min) || 15,
    sesion_horas: parseInt(sesion_horas) || 8,
    forzar_cambio_password: forzar_cambio_password === 'true' ? 'true' : 'false'
  };
  for (const [clave, valor] of Object.entries(valores)) {
    await db.run2(
      'UPDATE configuracion_sistema SET valor=$1 WHERE clave=$2',
      [String(valor), clave]
    );
  }
  await registrar(req, 'cambio_seguridad', JSON.stringify(valores));
  res.redirect('/configuracion?msg=seguridad_actualizada&tab=seguridad');
});

module.exports = router;
