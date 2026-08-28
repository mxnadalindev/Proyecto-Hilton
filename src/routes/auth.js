const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { registrar } = require('./auditoria');

const intentos = new Map();
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;

function verificarBloqueo(email) {
  const d = intentos.get(email);
  if (!d) return false;
  if (d.count >= MAX_INTENTOS) {
    const restante = BLOQUEO_MS - (Date.now() - d.tiempo);
    if (restante > 0) return Math.ceil(restante / 60000);
    intentos.delete(email);
  }
  return false;
}

function registrarIntento(email, ok) {
  if (ok) { intentos.delete(email); return; }
  const d = intentos.get(email) || { count: 0, tiempo: 0 };
  d.count++;
  d.tiempo = Date.now();
  intentos.set(email, d);
}

function renderLogin(res, opts = {}) {
  res.render('login', {
    error:    opts.error    || null,
    info:     opts.info     || null,
    success:  opts.success  || null,
    errorReg: opts.errorReg || null,
  });
}

router.get('/', (req, res) => {
  res.redirect(req.session.usuario ? '/inicio' : '/login');
});

router.get('/login', (req, res) => {
  if (req.session.usuario) return res.redirect('/inicio');
  const info = req.query.msg === 'sesion_expirada'
    ? 'Tu sesión expiró por inactividad. Ingresá nuevamente.'
    : null;
  renderLogin(res, { info });
});

router.post('/login', async (req, res) => {
  const email    = (req.body.email    || '').toLowerCase().trim();
  const password = (req.body.password || '');

  const minutos = verificarBloqueo(email);
  if (minutos) {
    return renderLogin(res, {
      error: `Cuenta bloqueada. Intentá en ${minutos} minuto${minutos > 1 ? 's' : ''}.`
    });
  }

  try {
    // Los mozos (eventuales/fijos/agencia) no siempre tienen email corporativo,
    // así que además de por email se puede entrar con el CUIL (guardado en
    // "legajo" — es el mismo campo que ya se usaba como identificador libre).
    const user = await db.get2(
      'SELECT * FROM usuarios WHERE (email = $1 OR legajo = $2) AND activo = 1',
      [email, (req.body.email || '').trim()]
    );

    if (user && password && bcrypt.compareSync(password, user.password)) {
      registrarIntento(email, true);
      req.session.usuario = { id: user.id, nombre: user.nombre, rol: user.rol, email: user.email, departamento: user.departamento, es_admin_general: user.es_admin_general };
      req.session.mostrarBienvenida = true;
      await registrar(req, 'login', user.email);
      return res.redirect('/inicio');
      };

    registrarIntento(email, false);
    const d = intentos.get(email);
    const restantes = d ? MAX_INTENTOS - d.count : MAX_INTENTOS;
    renderLogin(res, {
      error: `Usuario o contraseña incorrectos.${restantes <= 3 ? ` (${restantes} intento${restantes !== 1 ? 's' : ''} restante${restantes !== 1 ? 's' : ''})` : ''}`
    });
  } catch(e) {
    console.error('Error login:', e.message);
    renderLogin(res, { error: 'Error del servidor. Intentá nuevamente.' });
  }
});

router.get('/logout', async (req, res) => {
  await registrar(req, 'logout', req.session.usuario?.email);
  req.session.destroy();
  res.redirect('/login');
});

// Mismos sectores de Cocina que en horarios.js/personal.js (duplicado acá
// a propósito para no depender de esos módulos — es una lista chica y
// estable, y evita acoplar rutas que no tienen nada que ver entre sí).
const SECTORES_COCINA = [
  'Supervisores','Comis de Recepción','Panadería',
  'Pastelería AM','Pastelería PM','Faro AM','Faro PM',
  'Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'
];
const DIAS_ALERTA_VENCIMIENTO_MOZO = 15;
const MESES_LIMITE_MOZO_EVENTUAL = 6;

// "Resumen rápido" de la home — antes esta pantalla terminaba en el
// detalle del módulo seleccionado y dejaba un tramo grande de espacio en
// blanco debajo. Estos números (activos, alertas, vencimientos) se
// muestran como un renglón de tarjetas al pie, para que la home aporte
// algo de un vistazo en vez de ser solo navegación al resto del sistema.
async function resumenRapido(usuario) {
  const rol = (usuario.rol || '').toLowerCase();
  const depto = (usuario.departamento || '').toLowerCase();
  const esAdmin = rol === 'admin';
  const esGestorAyb = esAdmin || rol === 'supervisor';

  if (depto === 'cocina' || (esAdmin && !depto)) {
    const hoy = new Date().toISOString().split('T')[0];
    const [{ activos }] = await db.all2(
      `SELECT COUNT(*)::int AS activos FROM usuarios WHERE activo=1 AND LOWER(rol)!='admin' AND departamento = ANY($1)`,
      [SECTORES_COCINA]
    );
    const conTurnoHoy = await db.all2(
      `SELECT DISTINCT u.departamento FROM usuarios u
       JOIN horarios_semanales h ON h.usuario_id = u.id AND h.fecha = $2
       WHERE u.activo=1 AND u.departamento = ANY($1)
         AND UPPER(h.valor) NOT IN ('OFF','VAC','RECOFF','LIBRE','ART','LICENCIA','CUMPLE','MUDANZA','FRANCO')
         AND h.valor IS NOT NULL AND h.valor != ''`,
      [SECTORES_COCINA, hoy]
    );
    const sectoresConGente = new Set(conTurnoHoy.map(r => r.departamento));
    const sectoresConActivos = await db.all2(
      `SELECT DISTINCT departamento FROM usuarios WHERE activo=1 AND departamento = ANY($1)`,
      [SECTORES_COCINA]
    );
    const alertasHoy = sectoresConActivos.filter(s => !sectoresConGente.has(s.departamento)).length;
    const [{ adeudado }] = await db.all2(
      `SELECT COALESCE(SUM(recoff_adeudado),0)::int AS adeudado FROM usuarios WHERE activo=1 AND departamento = ANY($1)`,
      [SECTORES_COCINA]
    );
    const [{ usados }] = await db.all2(
      `SELECT COUNT(*)::int AS usados FROM horarios_semanales h JOIN usuarios u ON u.id=h.usuario_id
       WHERE UPPER(h.valor)='RECOFF' AND u.activo=1 AND u.departamento = ANY($1)`,
      [SECTORES_COCINA]
    );
    return {
      tipo: 'cocina',
      tarjetas: [
        { icon: 'ti-users', valor: activos, etiqueta: 'Personal activo' },
        { icon: 'ti-alert-triangle', valor: alertasHoy, etiqueta: 'Sectores sin cobertura hoy', alerta: alertasHoy > 0 },
        { icon: 'ti-calendar-off', valor: Math.max(adeudado - usados, 0), etiqueta: 'RECOFF pendientes (total equipo)' },
      ],
    };
  }

  if (depto === 'ayb' && esGestorAyb) {
    const hoy = new Date().toISOString().split('T')[0];
    const [{ activos }] = await db.all2(
      `SELECT COUNT(*)::int AS activos FROM usuarios WHERE activo=1 AND LOWER(rol)!='admin' AND departamento='ayb'`
    );
    const [{ proximos }] = await db.all2(
      `SELECT COUNT(*)::int AS proximos FROM eventos_ayb WHERE fecha >= $1 AND (oculto IS NULL OR oculto = false)`,
      [hoy]
    );
    const mozosEventual = await db.all2(
      `SELECT fecha_alta::text FROM usuarios WHERE activo=1 AND departamento='ayb' AND modalidad='Eventual' AND fecha_alta IS NOT NULL`
    );
    const hoyMs = new Date(hoy + 'T00:00:00').getTime();
    const porVencer = mozosEventual.filter(m => {
      const venc = new Date(m.fecha_alta + 'T00:00:00');
      venc.setMonth(venc.getMonth() + MESES_LIMITE_MOZO_EVENTUAL);
      const dias = Math.round((venc.getTime() - hoyMs) / 86400000);
      return dias <= DIAS_ALERTA_VENCIMIENTO_MOZO;
    }).length;
    return {
      tipo: 'ayb',
      tarjetas: [
        { icon: 'ti-users', valor: activos, etiqueta: 'Mozos activos' },
        { icon: 'ti-calendar-event', valor: proximos, etiqueta: 'Eventos próximos' },
        { icon: 'ti-alert-triangle', valor: porVencer, etiqueta: 'Vencimientos en 15 días', alerta: porVencer > 0 },
      ],
    };
  }

  return null;
}

router.get('/inicio', async (req, res) => {
  if (!req.session.usuario) return res.redirect('/login');
  const mostrarBienvenida = !!req.session.mostrarBienvenida;
  delete req.session.mostrarBienvenida;
  let resumen = null;
  try {
    resumen = await resumenRapido(req.session.usuario);
  } catch (e) {
    console.error('Error calculando resumen rápido de inicio:', e.message);
  }
  res.render('inicio', { usuario: req.session.usuario, mostrarBienvenida, resumen });
});

router.get('/registro', (req, res) => {
  if (req.session.usuario) return res.redirect('/inicio');
  renderLogin(res);
});

// Registro: departamento='sistema' para que NO aparezca en Personal
router.post('/registro', async (req, res) => {
  const nombre    = (req.body.nombre    || '').trim();
  const email     = (req.body.email     || '').toLowerCase().trim();
  const cuil      = (req.body.cuil      || '').trim();
  const password  = (req.body.password  || '');
  const password2 = (req.body.password2 || '');

  if (!nombre || !password) {
    return renderLogin(res, { errorReg: 'Completá todos los campos.' });
  }
  if (!email && !cuil) {
    return renderLogin(res, { errorReg: 'Completá tu correo electrónico, o tu CUIL si sos de Alimentos y Bebidas.' });
  }
  if (password !== password2) {
    return renderLogin(res, { errorReg: 'Las contraseñas no coinciden.' });
  }
  if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return renderLogin(res, { errorReg: 'La contraseña debe tener mínimo 8 caracteres, una mayúscula y un número.' });
  }

  try {
    const hash = bcrypt.hashSync(password, 12);

    if (cuil) {
      // Alimentos y Bebidas: los mozos ya están cargados de antes por el
      // encargado (CUIL guardado en "legajo", con la contraseña por
      // defecto "Hilton2026!" — ver importar-mozos y /nuevo en
      // personal.js). Acá no se crea una cuenta nueva y desconectada: se
      // "activa" esa misma ficha con la contraseña que elige el mozo, así
      // queda relacionada con la persona correcta en vez de duplicarla.
      // El email es opcional en este flujo, así que NO sirve como marca
      // de "ya activada" — en cambio, se chequea si la contraseña
      // guardada todavía es la de fábrica: si ya la cambiaron, la cuenta
      // ya fue reclamada por otra persona y no se puede volver a activar.
      const existente = await db.get2(
        'SELECT id, password FROM usuarios WHERE legajo = $1 AND departamento = $2',
        [cuil, 'ayb']
      );
      if (!existente) {
        return renderLogin(res, {
          errorReg: 'No encontramos ese CUIL cargado en el sistema. Pedile al encargado de Alimentos y Bebidas que te cargue primero en "Miembro de equipo".'
        });
      }
      const esPasswordDeFabrica = bcrypt.compareSync('Hilton2026!', existente.password || '');
      if (!esPasswordDeFabrica) {
        return renderLogin(res, {
          errorReg: 'Esa cuenta ya fue activada antes. Iniciá sesión, o pedile al encargado que te resetee la contraseña si la olvidaste.'
        });
      }
      await db.run2('UPDATE usuarios SET password=$1, email=$2 WHERE id=$3', [hash, email || null, existente.id]);
      return renderLogin(res, { success: 'Cuenta activada. Ya podés iniciar sesión con tu CUIL o tu email.' });
    }

    const existe = await db.get2('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existe) return renderLogin(res, { errorReg: 'Ese email ya está registrado.' });

    // departamento='sistema' → no aparece en Personal (que filtra por sectores de cocina)
    await db.run2(
     'INSERT INTO usuarios (nombre, email, password, rol, departamento) VALUES ($1, $2, $3, $4, $5)',
      [nombre, email, hash, 'empleado', req.body.departamento || 'cocina']
    );
    renderLogin(res, { success: `Cuenta creada para ${nombre}. Ya podés iniciar sesión.` });
  } catch(e) {
    console.error('Error registro:', e.message);
    renderLogin(res, { errorReg: 'Error al crear la cuenta. Intentá nuevamente.' });
  }
});

module.exports = router;
