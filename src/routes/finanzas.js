const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido, requiereDepartamento } = require('./middleware');

router.get('/', loginRequerido, requiereDepartamento('/finanzas'), async (req, res) => {
  res.render('finanzas', {});
});

module.exports = router;
