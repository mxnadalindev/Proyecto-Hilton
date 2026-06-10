// src/routes/recetas.js
const express = require('express');
const router = express.Router();
const db = require('../db/database');
const multer = require('multer');
const path = require('path');
const { loginRequerido } = require('./middleware');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

router.get('/', loginRequerido, (req, res) => {
  const busqueda = req.query.q || '';
  const recetas = busqueda
    ? db.prepare("SELECT * FROM recetas WHERE nombre LIKE ? OR categoria LIKE ? ORDER BY nombre")
        .all(`%${busqueda}%`, `%${busqueda}%`)
    : db.prepare("SELECT * FROM recetas ORDER BY nombre").all();
  res.render('recetas', { recetas, busqueda });
});

router.get('/nueva', loginRequerido, (req, res) => {
  res.render('receta_nueva', {});
});

router.post('/nueva', loginRequerido, upload.fields([
  { name: 'imagen', maxCount: 1 },
  { name: 'video', maxCount: 1 }
]), (req, res) => {
  const { nombre, categoria, ingredientes, pasos, video_url, area } = req.body;
  const imagen = req.files?.imagen?.[0]?.filename || null;
  const video  = req.files?.video?.[0]?.filename || video_url || null;

  db.prepare(`
    INSERT INTO recetas (nombre, categoria, ingredientes, pasos, video_url, imagen, area)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(nombre, categoria, ingredientes, pasos, video, imagen, area);

  res.redirect('/recetas');
});

router.get('/:id', loginRequerido, (req, res) => {
  const receta = db.prepare("SELECT * FROM recetas WHERE id = ?").get(req.params.id);
  if (!receta) return res.redirect('/recetas');
  res.render('receta_detalle', { receta });
});

module.exports = router;
