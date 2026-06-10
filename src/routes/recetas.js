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
const upload = multer({ storage, limits: { fileSize: 500*1024*1024 } });

router.get('/', loginRequerido, async (req, res) => {
  const busqueda = req.query.q || '';
  const recetas = busqueda
    ? await db.all2("SELECT * FROM recetas WHERE nombre ILIKE $1 OR categoria ILIKE $1 ORDER BY nombre", [`%${busqueda}%`])
    : await db.all2("SELECT * FROM recetas ORDER BY nombre");
  res.render('recetas', { recetas, busqueda });
});

router.get('/nueva', loginRequerido, (req, res) => {
  res.render('receta_nueva');
});

router.post('/nueva', loginRequerido, upload.fields([
  { name: 'imagen', maxCount: 1 },
  { name: 'video', maxCount: 1 }
]), async (req, res) => {
  const { nombre, categoria, ingredientes, pasos, video_url, area } = req.body;
  const imagen = req.files?.imagen?.[0]?.filename || null;
  const video  = req.files?.video?.[0]?.filename  || video_url || null;
  await db.run2(
    "INSERT INTO recetas (nombre,categoria,ingredientes,pasos,video_url,imagen,area) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [nombre, categoria, ingredientes, pasos, video, imagen, area]
  );
  res.redirect('/recetas');
});

router.get('/:id', loginRequerido, async (req, res) => {
  const receta = await db.get2("SELECT * FROM recetas WHERE id=$1", [req.params.id]);
  if (!receta) return res.redirect('/recetas');
  res.render('receta_detalle', { receta });
});

router.post('/:id/eliminar', loginRequerido, async (req, res) => {
  await db.run2("DELETE FROM recetas WHERE id=$1", [req.params.id]);
  res.redirect('/recetas');
});

module.exports = router;
