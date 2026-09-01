require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const os = require('os');

['uploads'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
const PORT = process.env.PORT || 5000;

// ── Red de seguridad global ─────────────────────────────────────────
// Varias rutas del portal hacen "await db.all2(...)" sin try/catch. Si esa
// consulta falla (una tabla que todavía no existe en esta instancia, un
// corte momentáneo de conexión con Postgres, etc.), la promesa rechazada
// queda "sin capturar" — y desde Node 15 eso tira abajo TODO el proceso,
// no solo esa página (así se cayó el server al entrar a Configuración).
// Con este handler, ese mismo error se loguea en la consola pero el
// servidor sigue de pie para todos los demás usuarios conectados.
process.on('unhandledRejection', (reason) => {
  console.error('⚠ Promesa rechazada sin capturar (el servidor sigue corriendo):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠ Excepción sin capturar (el servidor sigue corriendo):', err);
});

app.use(express.urlencoded({ extended: true, limit: '2gb' }));
app.use(express.json({ limit: '2gb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '60s', // ayuda a que no se re-pida todo en cada página, sin arriesgar quedarse con CSS viejo por mucho tiempo mientras seguimos cambiando cosas
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Las páginas del portal (Personal, Horarios, etc.) nunca se guardan en caché del navegador —
// siempre se piden frescas al servidor, así los cambios (como el RECOFF) se ven de una,
// sin que el usuario tenga que recargar fuerte a mano.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// Complemento del handler de unhandledRejection de arriba: si una ruta se
// cuelga porque su promesa rechazada quedó "atrapada" sin responder nunca
// (en vez de tirar el servidor abajo, como pasaba antes), este timeout hace
// que el usuario vea una página de error a los 20s en vez de un spinner
// infinito en el navegador.
app.use((req, res, next) => {
  // OJO: esto es un timer de JS común, NO req.setTimeout()/socket.setTimeout()
  // — probamos esa opción primero y en este Node (v22) el socket se cierra
  // solo al vencer el timeout, sin darle nunca la oportunidad al callback
  // de mandar una respuesta (el navegador termina viendo una conexión
  // cortada en vez de la página de error). Con un timer normal sí funciona.
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      console.error(`⚠ Timeout de 20s en ${req.method} ${req.originalUrl}`);
      res.status(504).render('error', {
        mensaje: 'La página tardó demasiado en responder. Probá de nuevo — si vuelve a pasar, avisale al admin.',
        volver: '/inicio',
      });
    }
  }, 20000);
  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  next();
});

app.use(session({
  // Igual que la contraseña de la base: se puede fijar SESSION_SECRET en el
  // .env para no tener un secreto hardcodeado en el código fuente público
  // del repo — si no está seteada, sigue usando la misma de siempre.
  secret: process.env.SESSION_SECRET || 'hilton_ba_futurelab_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    httpOnly: true,
    sameSite: 'lax'
    // Sin maxAge = cookie de sesión, se destruye al cerrar el navegador
  }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

require('./src/db/database');

app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  next();
});
app.use('/configuracion', require('./src/routes/configuracion'));
app.use('/',         require('./src/routes/auth'));
app.use('/eventos',  require('./src/routes/eventos'));
// "/miembros-de-equipo" es la URL nueva y la que se linkea desde el menú;
// "/personal" se deja funcionando en paralelo (mismo router) por si quedó
// algún acceso directo o favorito guardado con la URL vieja — las rutas
// internas del propio router (formularios, redirects) siguen usando
// "/personal" adentro, así que no hace falta tocar nada más para que sigan
// andando igual sin importar por cuál de las dos entraste.
app.use('/miembros-de-equipo', require('./src/routes/personal'));
app.use('/personal', require('./src/routes/personal'));
app.use('/recetas',  require('./src/routes/recetas'));
app.use('/horarios', require('./src/routes/horarios'));
app.use('/costos',   require('./src/routes/costos'));
app.use('/compras',  require('./src/routes/compras'));   // ← NUEVO
app.use('/croutons', require('./src/routes/croutons'));  // ← NUEVO — AYB: carga de mercadería y vencimientos
app.use('/asistente', require('./src/routes/asistente'));

// 404 — ruta que no matcheó ninguna de las de arriba
app.use((req, res) => {
  res.status(404).render('error', {
    mensaje: 'Esa página no existe.',
    volver: '/inicio',
  });
});

// Manejador de errores de Express (4 argumentos) — última red de
// contención: si alguna ruta llama a next(err) explícitamente, cae acá
// en vez de mostrar el stack trace crudo de Express al usuario.
app.use((err, req, res, next) => {
  console.error('⚠ Error en', req.method, req.originalUrl, ':', err.message);
  if (res.headersSent) return next(err);
  res.status(500).render('error', {
    mensaje: 'Ocurrió un error inesperado. Probá de nuevo — si vuelve a pasar, avisale al admin.',
    volver: '/inicio',
  });
});

// Mostrar IPs de acceso
function getIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        ips.push(alias.address);
      }
    }
  }
  return ips;
}

app.listen(PORT, '0.0.0.0', () => {
  const ips = getIPs();
  console.log('\n✓ Hilton Portal corriendo\n');
  console.log(`  Esta PC:    http://localhost:${PORT}`);
  ips.forEach(ip => {
    console.log(`  Red local:  http://${ip}:${PORT}  ← usar en celulares`);
  });
  console.log('\n  Compartí el link de "Red local" con los celulares\n');

  // Abre el navegador automáticamente en esta PC (no en los celulares, obvio)
  const urlLocal = `http://localhost:${PORT}`;
  const comandoPorSO = {
    win32: `start "" "${urlLocal}"`,
    darwin: `open "${urlLocal}"`,
    linux: `xdg-open "${urlLocal}"`,
  }[process.platform];

  if (comandoPorSO) {
    require('child_process').exec(comandoPorSO, (err) => {
      if (err) console.log('  (No se pudo abrir el navegador solo — abrilo a mano en la URL de arriba)');
    });
  }
});
