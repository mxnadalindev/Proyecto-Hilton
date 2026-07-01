const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');
const multer = require('multer');
const path = require('path');
const { analizarFactura } = require('../services/gemini');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, 'factura_'+Date.now()+path.extname(file.originalname))
});
const upload = multer({ storage, limits:{fileSize:10*1024*1024} });

router.get('/', loginRequerido, async (req, res) => {
  const insumos  = await db.all2("SELECT * FROM insumos ORDER BY categoria,nombre");
  const platos   = await db.all2("SELECT * FROM platos_costo ORDER BY nombre");
  const categorias = [...new Set(insumos.map(i=>i.categoria))];
  const msg = req.query.msg || null;
  const geminiConfigurado = !!process.env.GEMINI_API_KEY;
  res.render('costos', { insumos, platos, categorias, msg, geminiConfigurado });
});

router.post('/insumo/nuevo', loginRequerido, async (req, res) => {
  const { nombre, categoria, unidad, precio_unitario, stock_actual, proveedor } = req.body;
  await db.run2(
    "INSERT INTO insumos (nombre,categoria,unidad,precio_unitario,stock_actual,proveedor) VALUES ($1,$2,$3,$4,$5,$6)",
    [nombre, categoria||'General', unidad||'kg', parseFloat(precio_unitario)||0, parseFloat(stock_actual)||0, proveedor||'']
  );
  res.redirect('/costos');
});

router.post('/insumo/:id/precio', loginRequerido, async (req, res) => {
  const insumo = await db.get2("SELECT * FROM insumos WHERE id=$1", [req.params.id]);
  if (insumo) {
    await db.run2("INSERT INTO historial_precios (insumo_id,precio_anterior,precio_nuevo,origen) VALUES ($1,$2,$3,'manual')",
      [insumo.id, insumo.precio_unitario, parseFloat(req.body.precio_nuevo)]);
    await db.run2("UPDATE insumos SET precio_unitario=$1,actualizado_en=NOW() WHERE id=$2",
      [parseFloat(req.body.precio_nuevo), req.params.id]);
    await recalcularPlatos(insumo.id);
  }
  res.redirect('/costos');
});

router.post('/insumo/:id/eliminar', loginRequerido, async (req, res) => {
  await db.run2("DELETE FROM plato_insumos WHERE insumo_id=$1", [req.params.id]);
  await db.run2("DELETE FROM insumos WHERE id=$1", [req.params.id]);
  res.redirect('/costos');
});

router.post('/plato/nuevo', loginRequerido, async (req, res) => {
  const { nombre, categoria, porciones, precio_venta, margen_ganancia } = req.body;
  await db.run2(
    "INSERT INTO platos_costo (nombre,categoria,porciones,precio_venta,margen_ganancia) VALUES ($1,$2,$3,$4,$5)",
    [nombre, categoria||'', parseInt(porciones)||1, parseFloat(precio_venta)||0, parseFloat(margen_ganancia)||30]
  );
  res.redirect('/costos');
});

router.get('/plato/:id', loginRequerido, async (req, res) => {
  const plato = await db.get2("SELECT * FROM platos_costo WHERE id=$1", [req.params.id]);
  if (!plato) return res.redirect('/costos');
  const ingredientes = await db.all2(`
    SELECT pi.*,i.nombre as insumo_nombre,i.precio_unitario
    FROM plato_insumos pi JOIN insumos i ON pi.insumo_id=i.id WHERE pi.plato_id=$1
  `, [req.params.id]);
  const todosInsumos = await db.all2("SELECT * FROM insumos ORDER BY nombre");
  const historial = await db.all2(`
    SELECT hp.*,i.nombre as insumo_nombre FROM historial_precios hp
    JOIN insumos i ON hp.insumo_id=i.id ORDER BY hp.fecha DESC LIMIT 20
  `);
  res.render('costos_plato', { plato, ingredientes, todosInsumos, historial });
});

router.post('/plato/:id/insumo', loginRequerido, async (req, res) => {
  const { insumo_id, cantidad, unidad } = req.body;
  const insumo = await db.get2("SELECT * FROM insumos WHERE id=$1", [insumo_id]);
  if (insumo) {
    const costo_parcial = parseFloat(cantidad)*insumo.precio_unitario;
    await db.run2(
      "INSERT INTO plato_insumos (plato_id,insumo_id,cantidad,unidad,costo_parcial) VALUES ($1,$2,$3,$4,$5)",
      [req.params.id, insumo_id, parseFloat(cantidad), unidad||insumo.unidad, costo_parcial]
    );
    await recalcularCostoPlato(req.params.id);
  }
  res.redirect('/costos/plato/'+req.params.id);
});

router.post('/plato/:plato_id/insumo/:id/eliminar', loginRequerido, async (req, res) => {
  await db.run2("DELETE FROM plato_insumos WHERE id=$1", [req.params.id]);
  await recalcularCostoPlato(req.params.plato_id);
  res.redirect('/costos/plato/'+req.params.plato_id);
});

router.post('/plato/:id/eliminar', loginRequerido, async (req, res) => {
  await db.run2("DELETE FROM plato_insumos WHERE plato_id=$1", [req.params.id]);
  await db.run2("DELETE FROM platos_costo WHERE id=$1", [req.params.id]);
  res.redirect('/costos');
});

// ── Análisis de facturas con Gemini ────────────────────

// Normaliza texto para comparar nombres (minúsculas, sin tildes, sin espacios extra)
function normalizar(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca tildes
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Distancia de Levenshtein simple, para medir similitud entre nombres
function distanciaLevenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Similitud 0..1 (1 = idéntico), combinando Levenshtein + si una contiene a la otra
function similitud(nombreA, nombreB) {
  const a = normalizar(nombreA);
  const b = normalizar(nombreB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const dist = distanciaLevenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - (dist / maxLen);
}

// Busca el insumo existente más parecido a un nombre detectado por Gemini.
// Devuelve null si el mejor match está por debajo del umbral (probablemente es un insumo nuevo).
function buscarInsumoMasParecido(nombreDetectado, insumos) {
  let mejor = null;
  let mejorScore = 0;
  for (const insumo of insumos) {
    const score = similitud(nombreDetectado, insumo.nombre);
    if (score > mejorScore) {
      mejorScore = score;
      mejor = insumo;
    }
  }
  const UMBRAL = 0.55;
  return mejorScore >= UMBRAL ? mejor : null;
}

// 1) Sube la foto, la manda a Gemini, arma la comparación y la deja pendiente en sesión
router.post('/factura', loginRequerido, upload.single('factura'), async (req, res) => {
  if (!req.file) return res.redirect('/costos?msg=' + encodeURIComponent('No se recibió ninguna imagen.'));

  try {
    const itemsDetectados = await analizarFactura(req.file.path);

    if (itemsDetectados.length === 0) {
      return res.redirect('/costos?msg=' + encodeURIComponent('No se pudo leer ningún ítem en la factura.'));
    }

    const insumos = await db.all2("SELECT * FROM insumos");

    const comparacion = itemsDetectados.map((item, i) => {
      const match = buscarInsumoMasParecido(item.nombre, insumos);
      return {
        idx: i,
        nombre_detectado: item.nombre,
        cantidad: item.cantidad,
        unidad: item.unidad,
        precio_detectado: item.precio_unitario,
        insumo_id: match ? match.id : null,
        insumo_nombre: match ? match.nombre : null,
        precio_actual: match ? match.precio_unitario : null,
        sube: match ? item.precio_unitario > match.precio_unitario : null
      };
    });

    // Guardamos la comparación en sesión para la pantalla de confirmación
    req.session.facturaPendiente = comparacion;

    res.redirect('/costos/factura/revisar');
  } catch (e) {
    console.error('Error analizando factura con Gemini:', e.message);
    res.redirect('/costos?msg=' + encodeURIComponent('Error analizando la factura: ' + e.message));
  }
});

// 2) Muestra la pantalla de confirmación con lo que Gemini detectó
router.get('/factura/revisar', loginRequerido, async (req, res) => {
  const comparacion = req.session.facturaPendiente || [];
  res.render('factura_revisar', { comparacion });
});

// 3) Aplica los cambios que el usuario tildó y confirmó
router.post('/factura/aplicar', loginRequerido, async (req, res) => {
  const comparacion = req.session.facturaPendiente || [];
  let seleccionados = req.body.aplicar || [];
  if (!Array.isArray(seleccionados)) seleccionados = [seleccionados];
  const idxsSeleccionados = seleccionados.map(s => parseInt(s));

  try {
    for (const idx of idxsSeleccionados) {
      const item = comparacion[idx];
      if (!item || !item.insumo_id) continue; // sin match a insumo existente, no tocamos nada

      await db.run2(
        "INSERT INTO historial_precios (insumo_id,precio_anterior,precio_nuevo,origen) VALUES ($1,$2,$3,'gemini')",
        [item.insumo_id, item.precio_actual, item.precio_detectado]
      );
      await db.run2(
        "UPDATE insumos SET precio_unitario=$1,actualizado_en=NOW() WHERE id=$2",
        [item.precio_detectado, item.insumo_id]
      );
      await recalcularPlatos(item.insumo_id);
    }

    delete req.session.facturaPendiente;
    res.redirect('/costos?msg=' + encodeURIComponent(`${idxsSeleccionados.length} precio(s) actualizados desde factura.`));
  } catch (e) {
    console.error('Error aplicando precios de factura:', e.message);
    res.redirect('/costos?msg=' + encodeURIComponent('Error aplicando los cambios: ' + e.message));
  }
});

async function recalcularCostoPlato(plato_id) {
  const items = await db.all2("SELECT * FROM plato_insumos WHERE plato_id=$1", [plato_id]);
  const total = items.reduce((s,i) => s+(i.costo_parcial||0), 0);
  await db.run2("UPDATE platos_costo SET costo_total=$1 WHERE id=$2", [total, plato_id]);
}

async function recalcularPlatos(insumo_id) {
  const platos = await db.all2("SELECT DISTINCT plato_id FROM plato_insumos WHERE insumo_id=$1", [insumo_id]);
  const insumo = await db.get2("SELECT precio_unitario FROM insumos WHERE id=$1", [insumo_id]);
  for (const p of platos) {
    const items = await db.all2("SELECT * FROM plato_insumos WHERE plato_id=$1", [p.plato_id]);
    for (const item of items) {
      if (item.insumo_id == insumo_id) {
        await db.run2("UPDATE plato_insumos SET costo_parcial=$1 WHERE id=$2",
          [item.cantidad*insumo.precio_unitario, item.id]);
      }
    }
    await recalcularCostoPlato(p.plato_id);
  }
}

module.exports = router;
