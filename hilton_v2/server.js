// server.js — Hilton Portal v2
// Node.js + Express + SQLite

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

// Asegurar carpetas necesarias
['data', 'uploads'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
const PORT = 5000;

// ── Middleware ────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({
  secret: 'hilton_ba_futurelab_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 horas
}));

// ── Motor de vistas ───────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Base de datos ─────────────────────────────────────
const db = require('./src/db/database');

// ── Middleware global: pasar usuario a todas las vistas ─
app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  next();
});

// ── Rutas ─────────────────────────────────────────────
app.use('/', require('./src/routes/auth'));
app.use('/eventos', require('./src/routes/eventos'));
app.use('/personal', require('./src/routes/personal'));
app.use('/recetas', require('./src/routes/recetas'));

// ── Arrancar ──────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✓ Hilton Portal corriendo en http://localhost:${PORT}\n`);
});

module.exports = app;
