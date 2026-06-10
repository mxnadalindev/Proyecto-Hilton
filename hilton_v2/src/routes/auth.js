// src/routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');

router.get('/', (req, res) => {
  if (req.session.usuario) return res.redirect('/inicio');
  res.redirect('/login');
});

router.get('/login', (req, res) => {
  if (req.session.usuario) return res.redirect('/inicio');
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM usuarios WHERE email = ? AND activo = 1").get(email?.toLowerCase().trim());
  if (user && bcrypt.compareSync(password, user.password)) {
    req.session.usuario = { id: user.id, nombre: user.nombre, rol: user.rol };
    return res.redirect('/inicio');
  }
  res.render('login', { error: 'Email o contraseña incorrectos.' });
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

router.get('/inicio', loginRequerido, (req, res) => {
  res.render('inicio');
});

function loginRequerido(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}

module.exports = router;
