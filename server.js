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

app.use(express.urlencoded({ extended: true, limit: '2gb' }));
app.use(express.json({ limit: '2gb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '60s', // ayuda a que no se re-pida todo en cada página, sin arriesgar quedarse con CSS viejo por mucho tiempo mientras seguimos cambiando cosas
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({
  secret: 'hilton_ba_futurelab_2026',
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
app.use('/personal', require('./src/routes/personal'));
app.use('/recetas',  require('./src/routes/recetas'));
app.use('/horarios', require('./src/routes/horarios'));
app.use('/costos',   require('./src/routes/costos'));
app.use('/compras',  require('./src/routes/compras'));   // ← NUEVO
app.use('/finanzas', require('./src/routes/finanzas'));  // ← NUEVO

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
