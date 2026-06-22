const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido, requiereDepartamento } = require('./middleware');

router.get('/', loginRequerido, requiereDepartamento('/compras'), async (req, res) => {
  res.render('compras', {});
});

module.exports = router;
