const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido, requiereDepartamento } = require('./middleware');

router.get('/', loginRequerido, requiereDepartamento('/compras'), async (req, res) => {
  try {
    res.render('compras', {});
  } catch (e) {
    console.error('Error cargando Compras:', e.message);
    res.render('error', {
      mensaje: 'No se pudo cargar Compras. Probá de nuevo — si vuelve a pasar, avisale al admin.',
      volver: '/inicio',
    });
  }
});

module.exports = router;
