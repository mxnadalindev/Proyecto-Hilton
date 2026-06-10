const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');

// ── Rate limiting ────────────────────────────────────
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

// ── Helpers render ───────────────────────────────────
function renderLogin(res, opts = {}) {
  res.render('login', {
    error:    opts.error    || null,
    info:     opts.info     || null,
    success:  opts.success  || null,
    errorReg: opts.errorReg || null,
  });
}

// ── Rutas ─────────────────────────────────────────────
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
    const user = await db.get2(
      'SELECT * FROM usuarios WHERE email = $1 AND activo = 1',
      [email]
    );

    if (user && password && bcrypt.compareSync(password, user.password)) {
      registrarIntento(email, true);
      req.session.usuario = { id: user.id, nombre: user.nombre, rol: user.rol, email: user.email };
      return res.redirect('/inicio');
    }

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

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

router.get('/inicio', (req, res) => {
  if (!req.session.usuario) return res.redirect('/login');
  res.render('inicio');
});

// ── Registro ─────────────────────────────────────────
router.get('/registro', (req, res) => {
  if (req.session.usuario) return res.redirect('/inicio');
  renderLogin(res);
});

router.post('/registro', async (req, res) => {
  const nombre    = (req.body.nombre    || '').trim();
  const email     = (req.body.email     || '').toLowerCase().trim();
  const password  = (req.body.password  || '');
  const password2 = (req.body.password2 || '');

  if (!nombre || !email || !password) {
    return renderLogin(res, { errorReg: 'Completá todos los campos.' });
  }
  if (password !== password2) {
    return renderLogin(res, { errorReg: 'Las contraseñas no coinciden.' });
  }
  if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return renderLogin(res, { errorReg: 'La contraseña debe tener mínimo 8 caracteres, una mayúscula y un número.' });
  }

  try {
    const existe = await db.get2('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existe) return renderLogin(res, { errorReg: 'Ese email ya está registrado.' });

    const hash = bcrypt.hashSync(password, 12);
    await db.run2(
      'INSERT INTO usuarios (nombre, email, password, rol) VALUES ($1, $2, $3, $4)',
      [nombre, email, hash, 'empleado']
    );
    renderLogin(res, { success: `Cuenta creada para ${nombre}. Ya podés iniciar sesión.` });
  } catch(e) {
    console.error('Error registro:', e.message);
    renderLogin(res, { errorReg: 'Error al crear la cuenta. Intentá nuevamente.' });
  }
});

module.exports = router;
