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
// (esto ya estaba resuelto en tu código, no se toca)
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

// Listas fijas de Áreas (secciones de cocina) y Categorías (tipo de plato).
// El formulario también permite escribir "Otra" para casos que no estén acá,
// y si una receta vieja tiene un valor que ya no está en esta lista, igual se
// respeta y se muestra (no se pierde el dato).
const AREAS = [
  'Cocina I+D', 'Restaurante AM', 'Restaurante PM', 'Bar', 'Room Service',
  'BQT Frío', 'BQT Caliente', 'Panadería', 'Pastelería', 'Comedor',
];
const CATEGORIAS = [
  'Snack', 'Entrada', 'Principal', 'Corte', 'Postre', 'Tapa',
  'Sandwich', 'Sopas', 'Desayuno', 'Aderezos', 'Salsas',
];

function getOpciones() {
  return { categorias: CATEGORIAS, areas: AREAS };
}

// ── Ingredientes: ahora vienen de la tabla "insumos" (ing_insumo_id_N + ing_cantidad_N + ing_unidad_N) ──
// Ya NO se guarda nombre/precio a mano: el precio se calcula en el momento de mostrar la receta,
// leyendo insumos.precio_unitario. Si el precio del insumo cambia en Costos, la receta lo refleja solo.
function extraerIngredientes(body) {
  const indices = new Set();
  Object.keys(body).forEach(k => {
    const m = k.match(/^ing_insumo_id_(\d+)$/);
    if (m) indices.add(m[1]);
  });
  const filas = [];
  [...indices].forEach(idx => {
    const insumo_id = parseInt(body[`ing_insumo_id_${idx}`], 10);
    if (!insumo_id) return; // fila vacía (sin insumo elegido), se ignora
    filas.push({
      insumo_id,
      cantidad: parseFloat(body[`ing_cantidad_${idx}`]) || 0,
      unidad: (body[`ing_unidad_${idx}`] || '').trim(),
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

// Arma el array de fotos a partir de foto_clasificacion_N + archivos foto_archivo_N.
// Si en la edición no se elige un archivo nuevo para esa fila, conserva la foto que ya
// tenía guardada (foto_existente_N, precargada por la vista) — para no perderla al guardar.
function extraerFotos(body, files) {
  const indices = new Set();
  Object.keys(body).forEach(k => {
    const m = k.match(/^foto_clasificacion_(\d+)$/);
    if (m) indices.add(m[1]);
  });
  const fotos = [];
  [...indices].forEach(idx => {
    const clasificacion = body[`foto_clasificacion_${idx}`] || 'Otros';
    const archivoSubido = (files || []).find(f => f.fieldname === `foto_archivo_${idx}`);
    if (archivoSubido) {
      fotos.push({ clasificacion, archivo: archivoSubido.filename });
    } else {
      const existente = (body[`foto_existente_${idx}`] || '').trim();
      if (existente) fotos.push({ clasificacion, archivo: existente });
    }
  });
  return fotos;
}

async function guardarIngredientes(recetaId, ingredientes) {
  await db.run2("DELETE FROM receta_insumos WHERE receta_id=$1", [recetaId]);
  for (const ing of ingredientes) {
    await db.run2(
      `INSERT INTO receta_insumos (receta_id, insumo_id, cantidad, unidad) VALUES ($1,$2,$3,$4)`,
      [recetaId, ing.insumo_id, ing.cantidad, ing.unidad]
    );
  }
}

async function guardarFotos(recetaId, fotos) {
  await db.run2("DELETE FROM receta_fotos WHERE receta_id=$1", [recetaId]);
  let orden = 0;
  for (const f of fotos) {
    await db.run2(
      `INSERT INTO receta_fotos (receta_id, clasificacion, archivo, orden) VALUES ($1,$2,$3,$4)`,
      [recetaId, f.clasificacion, f.archivo, orden++]
    );
  }
}

// Imagen que se muestra en la tarjeta del listado: la "portada" si la cargaron,
// y si no, la primera foto clasificada (Preparación/Montaje/Otros) que tenga la receta.
// Así no hace falta subir la misma foto dos veces.
const SQL_IMAGEN_LISTADO = `
  COALESCE(
    r.imagen,
    (SELECT rf.archivo FROM receta_fotos rf WHERE rf.receta_id = r.id ORDER BY rf.orden, rf.id LIMIT 1)
  ) AS imagen_portada
`;

router.get('/', loginRequerido, async (req, res) => {
  const busqueda = req.query.q || '';
  const recetas = busqueda
    ? await db.all2(`
        SELECT r.*, ${SQL_IMAGEN_LISTADO},
               EXISTS(SELECT 1 FROM receta_videos v WHERE v.receta_id=r.id) AS tiene_video
        FROM recetas r WHERE r.nombre ILIKE $1 OR r.categoria ILIKE $1 ORDER BY r.nombre`, [`%${busqueda}%`])
    : await db.all2(`
        SELECT r.*, ${SQL_IMAGEN_LISTADO},
               EXISTS(SELECT 1 FROM receta_videos v WHERE v.receta_id=r.id) AS tiene_video
        FROM recetas r ORDER BY r.nombre`);
  res.render('recetas', { recetas, busqueda, puedeEditar: esAdminOSupervisor(req) });
});

router.get('/nueva', loginRequerido, requiereEdicion, async (req, res) => {
  const { categorias, areas } = await getOpciones();
  const todosInsumos = await db.all2('SELECT id, nombre, unidad, precio_unitario FROM insumos ORDER BY nombre');
  res.render('receta_nueva', {
    path: req.path, categorias, areas, receta: null,
    ingredientesActuales: [], videos: [], fotos: [], todosInsumos,
  });
});

router.post('/nueva', loginRequerido, requiereEdicion, upload.any(), async (req, res) => {
  const categoria = req.body.categoria === 'otro' ? (req.body.categoria_otro || '').trim() : (req.body.categoria || '').trim();
  const area = req.body.area === 'otro' ? (req.body.area_otro || '').trim() : (req.body.area || '').trim();
  const nombre = req.body.nombre || '';
  const procedimiento = req.body.procedimiento || '';

  const ingredientes = extraerIngredientes(req.body);
  const videos = extraerVideos(req.body, req.files);
  const fotos = extraerFotos(req.body, req.files);
  const imagen = (req.files || []).find(f => f.fieldname === 'imagen')?.filename || null;

  const nueva = await db.get2(
    `INSERT INTO recetas (nombre,categoria,procedimiento,imagen,area)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [nombre, categoria, procedimiento, imagen, area]
  );

  await guardarIngredientes(nueva.id, ingredientes);
  await guardarFotos(nueva.id, fotos);

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
  const fotos = await db.all2("SELECT * FROM receta_fotos WHERE receta_id=$1 ORDER BY orden, id", [req.params.id]);
  const ingredientesActuales = await db.all2(`
    SELECT ri.insumo_id, ri.cantidad, ri.unidad, i.nombre AS insumo_nombre, i.precio_unitario
    FROM receta_insumos ri JOIN insumos i ON i.id = ri.insumo_id
    WHERE ri.receta_id=$1 ORDER BY ri.id`, [req.params.id]);

  const { categorias, areas } = await getOpciones();
  const todosInsumos = await db.all2('SELECT id, nombre, unidad, precio_unitario FROM insumos ORDER BY nombre');

  res.render('receta_nueva', {
    path: req.path, categorias, areas, receta,
    ingredientesActuales, videos, fotos, todosInsumos,
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

  const ingredientes = extraerIngredientes(req.body);
  const videosNuevos = extraerVideos(req.body, req.files);
  const fotos = extraerFotos(req.body, req.files);
  const nuevaImagen = (req.files || []).find(f => f.fieldname === 'imagen')?.filename;
  const imagen = nuevaImagen || receta.imagen;

  await db.run2(
    `UPDATE recetas SET nombre=$1, categoria=$2, procedimiento=$3, imagen=$4, area=$5 WHERE id=$6`,
    [nombre, categoria, procedimiento, imagen, area, id]
  );

  await guardarIngredientes(id, ingredientes);
  await guardarFotos(id, fotos);

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
  const fotos = await db.all2("SELECT * FROM receta_fotos WHERE receta_id=$1 ORDER BY orden, id", [req.params.id]);

  // Ingredientes con precio EN VIVO (tomado de insumos, no guardado a mano)
  const ingredientes = await db.all2(`
    SELECT ri.id, ri.cantidad, ri.unidad, i.nombre, i.precio_unitario
    FROM receta_insumos ri JOIN insumos i ON i.id = ri.insumo_id
    WHERE ri.receta_id=$1 ORDER BY ri.id`, [req.params.id]);

  const costoTotal = ingredientes.reduce(
    (acc, ing) => acc + (parseFloat(ing.cantidad) || 0) * (parseFloat(ing.precio_unitario) || 0), 0
  );

  res.render('receta_detalle', {
    receta, videos, fotos, ingredientes, costoTotal,
    puedeEditar: esAdminOSupervisor(req),
  });
});

router.post('/:id/eliminar', loginRequerido, requiereEdicion, async (req, res) => {
  await db.run2("DELETE FROM recetas WHERE id=$1", [req.params.id]);
  res.redirect('/recetas');
});

module.exports = router;
