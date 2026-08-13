const express = require('express');
const router = express.Router();
const db = require('../db/database');
const multer = require('multer');
const path = require('path');
const { loginRequerido } = require('./middleware');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

// ── Permisos: solo admin/supervisor crean, editan o eliminan recetas ──
function esAdminOSupervisor(req) {
  const rol = req.session?.usuario?.rol;
  return rol === 'admin' || rol === 'supervisor';
}
function requiereEdicion(req, res, next) {
  if (!esAdminOSupervisor(req)) {
    return res.status(403).render('error', {
      mensaje: 'Solo administradores y supervisores pueden crear, editar o eliminar recetas. El personal de cocina puede visualizarlas.',
      volver: '/recetas',
    });
  }
  next();
}

// Categorías/áreas ya usadas en recetas existentes, para poblar los <select>
async function getOpciones() {
  const cats = await db.all2("SELECT DISTINCT categoria FROM recetas WHERE categoria IS NOT NULL AND categoria <> '' ORDER BY categoria");
  const areas = await db.all2("SELECT DISTINCT area FROM recetas WHERE area IS NOT NULL AND area <> '' ORDER BY area");
  return { categorias: cats.map(c => c.categoria), areas: areas.map(a => a.area) };
}

// Arma el array de ingredientes estructurados a partir de los campos ing_nombre_N / ing_cantidad_N / ing_precio_N
function extraerIngredientes(body) {
  const indices = new Set();
  Object.keys(body).forEach(k => {
    const m = k.match(/^ing_nombre_(\d+)$/);
    if (m) indices.add(m[1]);
  });
  const filas = [];
  [...indices].sort((a, b) => a - b).forEach(idx => {
    const nombre = (body[`ing_nombre_${idx}`] || '').trim();
    if (!nombre) return;
    filas.push({
      nombre,
      cantidad: (body[`ing_cantidad_${idx}`] || '').trim(),
      precio_unitario: parseFloat(body[`ing_precio_${idx}`]) || 0,
    });
  });
  return filas;
}

// Arma el array de videos a partir de video_clasificacion_N / video_tipo_N / video_url_N / archivos video_archivo_N
function extraerVideos(body, files) {
  const indices = new Set();
  Object.keys(body).forEach(k => {
    const m = k.match(/^video_clasificacion_(\d+)$/);
    if (m) indices.add(m[1]);
  });
  const videos = [];
  [...indices].forEach(idx => {
    const clasificacion = body[`video_clasificacion_${idx}`] || 'Otros';
    const tipo = body[`video_tipo_${idx}`] || 'url';
    if (tipo === 'archivo') {
      const archivo = (files || []).find(f => f.fieldname === `video_archivo_${idx}`);
      if (archivo) videos.push({ clasificacion, origen: 'archivo', valor: archivo.filename });
    } else {
      const url = (body[`video_url_${idx}`] || '').trim();
      if (url) videos.push({ clasificacion, origen: 'url', valor: url });
    }
  });
  return videos;
}

router.get('/', loginRequerido, async (req, res) => {
  const busqueda = req.query.q || '';
  const recetas = busqueda
    ? await db.all2(`
        SELECT r.*, EXISTS(SELECT 1 FROM receta_videos v WHERE v.receta_id=r.id) AS tiene_video
        FROM recetas r WHERE r.nombre ILIKE $1 OR r.categoria ILIKE $1 ORDER BY r.nombre`, [`%${busqueda}%`])
    : await db.all2(`
        SELECT r.*, EXISTS(SELECT 1 FROM receta_videos v WHERE v.receta_id=r.id) AS tiene_video
        FROM recetas r ORDER BY r.nombre`);
  res.render('recetas', { recetas, busqueda, puedeEditar: esAdminOSupervisor(req) });
});

router.get('/nueva', loginRequerido, requiereEdicion, async (req, res) => {
  const { categorias, areas } = await getOpciones();
  res.render('receta_nueva', { path: req.path, categorias, areas, receta: null, ingredientesJson: [], videos: [] });
});

router.post('/nueva', loginRequerido, requiereEdicion, upload.any(), async (req, res) => {
  const categoria = req.body.categoria === 'otro' ? (req.body.categoria_otro || '').trim() : (req.body.categoria || '').trim();
  const area = req.body.area === 'otro' ? (req.body.area_otro || '').trim() : (req.body.area || '').trim();
  const nombre = req.body.nombre || '';
  const procedimiento = req.body.procedimiento || '';

  const ingredientesJson = extraerIngredientes(req.body);
  const videos = extraerVideos(req.body, req.files);
  const imagen = (req.files || []).find(f => f.fieldname === 'imagen')?.filename || null;

  const nueva = await db.get2(
    `INSERT INTO recetas (nombre,categoria,ingredientes_json,procedimiento,imagen,area)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [nombre, categoria, JSON.stringify(ingredientesJson), procedimiento, imagen, area]
  );

  for (const v of videos) {
    await db.run2(
      `INSERT INTO receta_videos (receta_id, clasificacion, origen, valor) VALUES ($1,$2,$3,$4)`,
      [nueva.id, v.clasificacion, v.origen, v.valor]
    );
  }

  res.redirect('/recetas/' + nueva.id);
});

router.get('/:id/editar', loginRequerido, requiereEdicion, async (req, res) => {
  const receta = await db.get2("SELECT * FROM recetas WHERE id=$1", [req.params.id]);
  if (!receta) return res.redirect('/recetas');
  const videos = await db.all2("SELECT * FROM receta_videos WHERE receta_id=$1 ORDER BY orden, id", [req.params.id]);
  const { categorias, areas } = await getOpciones();
  res.render('receta_nueva', {
    path: req.path,
    categorias, areas,
    receta,
    ingredientesJson: receta.ingredientes_json || [],
    videos,
  });
});

router.post('/:id/editar', loginRequerido, requiereEdicion, upload.any(), async (req, res) => {
  const id = req.params.id;
  const receta = await db.get2("SELECT * FROM recetas WHERE id=$1", [id]);
  if (!receta) return res.redirect('/recetas');

  const categoria = req.body.categoria === 'otro' ? (req.body.categoria_otro || '').trim() : (req.body.categoria || '').trim();
  const area = req.body.area === 'otro' ? (req.body.area_otro || '').trim() : (req.body.area || '').trim();
  const nombre = req.body.nombre || '';
  const procedimiento = req.body.procedimiento || '';

  const ingredientesJson = extraerIngredientes(req.body);
  const videosNuevos = extraerVideos(req.body, req.files);
  const nuevaImagen = (req.files || []).find(f => f.fieldname === 'imagen')?.filename;
  const imagen = nuevaImagen || receta.imagen;

  await db.run2(
    `UPDATE recetas SET nombre=$1, categoria=$2, ingredientes_json=$3, procedimiento=$4, imagen=$5, area=$6 WHERE id=$7`,
    [nombre, categoria, JSON.stringify(ingredientesJson), procedimiento, imagen, area, id]
  );

  // Reemplaza los videos por los que se enviaron en el formulario (carga limpia)
  await db.run2("DELETE FROM receta_videos WHERE receta_id=$1", [id]);
  for (const v of videosNuevos) {
    await db.run2(
      `INSERT INTO receta_videos (receta_id, clasificacion, origen, valor) VALUES ($1,$2,$3,$4)`,
      [id, v.clasificacion, v.origen, v.valor]
    );
  }

  res.redirect('/recetas/' + id);
});

router.get('/:id', loginRequerido, async (req, res) => {
  const receta = await db.get2("SELECT * FROM recetas WHERE id=$1", [req.params.id]);
  if (!receta) return res.redirect('/recetas');
  const videos = await db.all2("SELECT * FROM receta_videos WHERE receta_id=$1 ORDER BY orden, id", [req.params.id]);
  res.render('receta_detalle', { receta, videos, puedeEditar: esAdminOSupervisor(req) });
});

router.post('/:id/eliminar', loginRequerido, requiereEdicion, async (req, res) => {
  await db.run2("DELETE FROM recetas WHERE id=$1", [req.params.id]);
  res.redirect('/recetas');
});

module.exports = router;
