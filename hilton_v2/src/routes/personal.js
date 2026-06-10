// src/routes/personal.js
const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');

router.get('/', loginRequerido, (req, res) => {
  const personal = db.prepare(
    "SELECT id, nombre, email, rol, creado_en FROM usuarios WHERE activo = 1 ORDER BY nombre"
  ).all();
  res.render('personal', { personal });
});

module.exports = router;
