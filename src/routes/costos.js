const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');
const multer = require('multer');
const path = require('path');

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
  res.render('costos', { insumos, platos, categorias, msg });
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

router.post('/factura', loginRequerido, upload.single('factura'), async (req, res) => {
  res.redirect('/costos?msg=foto_recibida');
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
