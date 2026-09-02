const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');
const { registrar } = require('./auditoria');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function soloAdmin(req, res, next) {
  // .toLowerCase(): el rol puede estar guardado con distinta capitalización
  // según cómo se haya creado la cuenta — sin esto, un admin con rol "Admin"
  // (en vez de "admin") quedaba bloqueado de Configuración por completo.
  const rol = (req.session.usuario?.rol || '').toLowerCase();
  if (rol !== 'admin') return res.redirect('/inicio');
  next();
}

// Antes esto distinguía "admin general" (sin departamento) de "admin de
// departamento" (Cocina, AYB, etc.), ocultándole Backups/Auditoría/
// Seguridad al segundo. A pedido, se sacó esa distinción: CUALQUIER admin,
// tenga o no departamento asignado, ve la Configuración completa. Lo que
// sigue sin cambiar es que un no-admin (cocinero, mozo eventual, etc.) no
// entra a esta pantalla en absoluto — eso lo sigue bloqueando soloAdmin,
// más arriba, sin relación con esta función.
//
// NOTA: en paralelo se armó (en otro chat) una versión más fina con un
// flag por cuenta (es_admin_general en la base) para dar acceso general
// solo a admins puntuales de departamento, sin dárselo a todos. Se dejó
// pendiente esa decisión — por ahora esta pantalla usa la versión simple,
// sin esa columna nueva (evita tener que correr una migración ahora).
function esGeneral(usuario) {
  const rol = (usuario?.rol || '').toLowerCase();
  return rol === 'admin';
}

function soloAdminGeneral(req, res, next) {
  if (!esGeneral(req.session.usuario)) return res.redirect('/configuracion');
  next();
}

// Activar/desactivar/eliminar/cambiar rol: un admin de departamento puede
// hacerlas, pero solo sobre gente de su propio sector — se verifica
// cargando al usuario destino antes de tocarlo (no alcanza con esconder el
// botón en la vista, cualquiera podría mandar el POST directo con otro :id).
async function puedeGestionar(req) {
  if (esGeneral(req.session.usuario)) return true;
  const destino = await db.get2('SELECT departamento FROM usuarios WHERE id=$1', [req.params.id]);
  return !!destino && destino.departamento === req.session.usuario.departamento;
}

const DEPTOS = ['cocina','ayb','compras','sistema'];
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
// Nota: cada consulta va con su propio try/catch — así, si algo puntual
// falla en la base (por ej. una tabla que todavía no se creó en esta
// instancia), la página igual carga con esa sección vacía en vez de
// tirar abajo el servidor entero por una promesa sin capturar.
router.get('/', loginRequerido, soloAdmin, async (req, res) => {
  const general = esGeneral(req.session.usuario);
  const miDepto = req.session.usuario.departamento;

  let usuarios = [];
  try {
    if (general) {
      usuarios = await db.all2(`
        SELECT id, nombre, email, rol, departamento, activo, creado_en::text as creado_en
        FROM usuarios
        WHERE departamento NOT IN ('Supervisores','Comis de Recepción','Panadería','Pastelería AM','Pastelería PM','Faro AM','Faro PM','Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D')
        OR departamento IS NULL
        ORDER BY creado_en DESC
      `);
    } else {
      // Admin de departamento: solo su propia gente.
      usuarios = await db.all2(`
        SELECT id, nombre, email, rol, departamento, activo, creado_en::text as creado_en
        FROM usuarios
        WHERE departamento = $1
        ORDER BY creado_en DESC
      `, [miDepto]);
    }
  } catch (e) {
    console.error('Error cargando usuarios en Configuración:', e.message);
  }

  // Backups, auditoría y seguridad son del sistema entero (una sola base
  // compartida, un solo login) — quedan reservados al admin general.
  let auditoria = [];
  const config = {};
  if (general) {
    try {
      auditoria = await db.all2(`
        SELECT id, usuario_nombre, accion, detalle, ip, creado_en::text as creado_en
        FROM auditoria ORDER BY creado_en DESC LIMIT 100
      `);
    } catch (e) {
      console.error('Error cargando auditoría en Configuración:', e.message);
    }

    try {
      const configRows = await db.all2('SELECT clave, valor FROM configuracion_sistema');
      configRows.forEach(r => config[r.clave] = r.valor);
    } catch (e) {
      console.error('Error cargando configuración del sistema:', e.message);
    }
  }

  const msg = req.query.msg || null;
  const backups = general ? getBackups() : [];
  res.render('configuracion', { usuarios, DEPTOS, SECTORES, msg, path: 'configuracion', backups, auditoria, config, general, miDepto });
});

// ── Usuarios ──────────────────────────────────────────
// Rol, activar, desactivar y eliminar: un admin de departamento SÍ puede
// hacerlas (es el supervisor de ese sector, tiene que poder ascender a su
// propia gente), pero solo sobre alguien de su propio departamento.
// Cambiar el departamento de alguien queda reservado al admin general —
// mover gente entre sectores cruza límites que un supervisor de un sector
// no debería poder tocar por su cuenta.
router.post('/usuario/:id/rol', loginRequerido, soloAdmin, async (req, res) => {
  if (!(await puedeGestionar(req))) return res.redirect('/configuracion');
  const u = await db.get2('SELECT nombre FROM usuarios WHERE id=$1', [req.params.id]);
  await db.run2('UPDATE usuarios SET rol=$1 WHERE id=$2', [req.body.rol, req.params.id]);
  await registrar(req, 'cambio_rol', `${u?.nombre} → ${req.body.rol}`);
  res.redirect('/configuracion?msg=rol_actualizado');
});

router.post('/usuario/:id/departamento', loginRequerido, soloAdminGeneral, async (req, res) => {
  const u = await db.get2('SELECT nombre FROM usuarios WHERE id=$1', [req.params.id]);
  await db.run2('UPDATE usuarios SET departamento=$1 WHERE id=$2', [req.body.departamento, req.params.id]);
  await registrar(req, 'cambio_departamento', `${u?.nombre} → ${req.body.departamento}`);
  res.redirect('/configuracion?msg=depto_actualizado');
});

// NOTA: acá vivía una ruta POST /usuario/:id/admin-general (armada en el
// otro chat en paralelo) que activaba/desactivaba el flag es_admin_general
// por cuenta. Se sacó junto con la columna, ya que la versión simple que
// se dejó por ahora en esGeneral() no la usa. Si en algún momento se
// retoma el diseño más fino, hay que traer de vuelta esta ruta, la
// columna en la base, y las dos referencias sacadas de los SELECT de
// usuarios más abajo.

router.post('/usuario/:id/activar', loginRequerido, soloAdmin, async (req, res) => {
  if (!(await puedeGestionar(req))) return res.redirect('/configuracion');
  const u = await db.get2('SELECT nombre FROM usuarios WHERE id=$1', [req.params.id]);
  await db.run2('UPDATE usuarios SET activo=1 WHERE id=$1', [req.params.id]);
  await registrar(req, 'activar_usuario', u?.nombre);
  res.redirect('/configuracion?msg=usuario_activado');
});

router.post('/usuario/:id/desactivar', loginRequerido, soloAdmin, async (req, res) => {
  if (!(await puedeGestionar(req))) return res.redirect('/configuracion');
  const u = await db.get2('SELECT nombre FROM usuarios WHERE id=$1', [req.params.id]);
  await db.run2('UPDATE usuarios SET activo=0 WHERE id=$1', [req.params.id]);
  await registrar(req, 'desactivar_usuario', u?.nombre);
  res.redirect('/configuracion?msg=usuario_desactivado');
});

router.post('/usuario/:id/eliminar', loginRequerido, soloAdmin, async (req, res) => {
  if (!(await puedeGestionar(req))) return res.redirect('/configuracion');
  const id = req.params.id;
  try {
    const u = await db.get2('SELECT nombre FROM usuarios WHERE id=$1', [id]);
    if (!u) return res.redirect('/configuracion?msg=' + encodeURIComponent('Ese usuario ya no existe.'));

    // Un DELETE liso y llano acá siempre fallaba: casi todo usuario tiene
    // filas que lo referencian (auditoría, horarios cargados, eventos que
    // creó, lotes de Croutons, etc.) y la mayoría de esas relaciones NO
    // tienen ON DELETE CASCADE en la base — Postgres rechaza el borrado
    // con un error de foreign key, y como no había try/catch acá, eso
    // tiraba abajo el pedido entero sin ningún mensaje claro para el admin.
    //
    // La solución no es cascadear todo a lo bruto — eso borraría historial
    // real (eventos, auditoría, lotes de mercadería) solo porque la
    // persona que los creó se da de baja del sistema. En vez de eso:
    // - Las tablas que son "su propio horario/agenda" (horarios,
    //   horarios_semanales, evento_personal) se le borran a ella junto con
    //   la cuenta — no tiene sentido dejarlas huérfanas.
    // - Las tablas que son registro/negocio (auditoría, eventos que creó,
    //   lotes de Croutons) se conservan, solo se les saca la referencia a
    //   este usuario (usuario_id/creado_por a NULL) para no perder ese
    //   historial.
    await db.run2('DELETE FROM horarios WHERE usuario_id=$1', [id]);
    await db.run2('DELETE FROM horarios_semanales WHERE usuario_id=$1', [id]);
    await db.run2('DELETE FROM evento_personal WHERE usuario_id=$1', [id]);
    await db.run2('UPDATE auditoria SET usuario_id=NULL WHERE usuario_id=$1', [id]);
    await db.run2('UPDATE eventos SET creado_por=NULL WHERE creado_por=$1', [id]);
    await db.run2('UPDATE eventos_ayb SET creado_por=NULL WHERE creado_por=$1', [id]);
    await db.run2('UPDATE croutons_lotes SET creado_por=NULL WHERE creado_por=$1', [id]);
    // disponibilidad y eventos_ayb_inscripciones sí tienen ON DELETE CASCADE.

    await db.run2('DELETE FROM usuarios WHERE id=$1', [id]);
    await registrar(req, 'eliminar_usuario', u.nombre);
    res.redirect('/configuracion?msg=usuario_eliminado');
  } catch (e) {
    console.error('Error eliminando usuario:', e.message);
    res.redirect('/configuracion?msg=' + encodeURIComponent('No se pudo eliminar el usuario: ' + e.message));
  }
});

// ── Backup ────────────────────────────────────────────
router.post('/backup/crear', loginRequerido, soloAdminGeneral, (req, res) => {
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

router.get('/backup/descargar/:nombre', loginRequerido, soloAdminGeneral, async (req, res) => {
  const archivo = path.join(BACKUPS_DIR, req.params.nombre);
  if (!fs.existsSync(archivo)) return res.redirect('/configuracion?msg=backup_no_encontrado');
  await registrar(req, 'backup_descargado', req.params.nombre);
  res.download(archivo);
});

router.post('/backup/eliminar/:nombre', loginRequerido, soloAdminGeneral, async (req, res) => {
  const archivo = path.join(BACKUPS_DIR, req.params.nombre);
  try { fs.unlinkSync(archivo); } catch(e) {}
  await registrar(req, 'backup_eliminado', req.params.nombre);
  res.redirect('/configuracion?msg=backup_eliminado');
});

router.post('/backup/restaurar/:nombre', loginRequerido, soloAdminGeneral, async (req, res) => {
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
router.post('/seguridad', loginRequerido, soloAdminGeneral, async (req, res) => {
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