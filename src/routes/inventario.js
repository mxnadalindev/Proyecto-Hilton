const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido, requiereDepartamento } = require('./middleware');
router.use(loginRequerido, requiereDepartamento('/inventario'));

// GET / — listado, con búsqueda y filtro de "por vencer"
router.get('/', async (req, res) => {
  const buscar = req.query.buscar || '';
  const soloPorVencer = req.query.porVencer === '1';

  let query = `SELECT * FROM inventario_ayb WHERE 1=1`;
  const params = [];

  if (buscar) {
    params.push(`%${buscar}%`);
    query += ` AND nombre ILIKE $${params.length}`;
  }
  if (soloPorVencer) {
    query += ` AND fecha_vencimiento IS NOT NULL AND fecha_vencimiento <= CURRENT_DATE + INTERVAL '15 days'`;
  }
  query += ` ORDER BY (fecha_vencimiento IS NULL), fecha_vencimiento ASC, nombre ASC`;

  const productos = await db.all2(query, params);

  const hoy = new Date();
  productos.forEach(p => {
    if (p.fecha_vencimiento) {
      const dias = Math.ceil((new Date(p.fecha_vencimiento) - hoy) / (1000 * 60 * 60 * 24));
      p.dias_para_vencer = dias;
      p.vencido = dias < 0;
      p.por_vencer = dias >= 0 && dias <= 15;
    }
    p.stock_bajo = p.stock_minimo > 0 && parseFloat(p.cantidad) <= parseFloat(p.stock_minimo);
  });

  const totalPorVencer = productos.filter(p => p.por_vencer).length;
  const totalVencidos = productos.filter(p => p.vencido).length;
  const totalStockBajo = productos.filter(p => p.stock_bajo).length;

  res.render('inventario', {
    path: 'inventario', productos, buscar, soloPorVencer,
    totalPorVencer, totalVencidos, totalStockBajo,
    msg: req.query.msg || null,
  });
});

// POST /nuevo — carga un producto (ej. al recibir mercadería)
router.post('/nuevo', async (req, res) => {
  const { nombre, categoria, cantidad, unidad, stock_minimo, proveedor, fecha_vencimiento } = req.body;
  if (!nombre || !nombre.trim()) return res.redirect('/inventario?msg=error');

  await db.run2(`
    INSERT INTO inventario_ayb (nombre, categoria, cantidad, unidad, stock_minimo, proveedor, fecha_vencimiento)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [
    nombre.trim(),
    categoria?.trim() || 'General',
    parseFloat(cantidad) || 0,
    unidad?.trim() || 'unidad',
    parseFloat(stock_minimo) || 0,
    proveedor?.trim() || null,
    fecha_vencimiento || null,
  ]);

  res.redirect('/inventario?msg=agregado');
});

// POST /:id/editar — reponer cantidad / actualizar vencimiento al recibir mercadería nueva
router.post('/:id/editar', async (req, res) => {
  const { cantidad, fecha_vencimiento, proveedor, stock_minimo } = req.body;
  await db.run2(`
    UPDATE inventario_ayb
    SET cantidad=$1, fecha_vencimiento=$2, proveedor=$3, stock_minimo=$4, actualizado_en=NOW()
    WHERE id=$5
  `, [
    parseFloat(cantidad) || 0,
    fecha_vencimiento || null,
    proveedor?.trim() || null,
    parseFloat(stock_minimo) || 0,
    req.params.id,
  ]);
  res.redirect('/inventario?msg=actualizado');
});

// POST /:id/eliminar
router.post('/:id/eliminar', async (req, res) => {
  await db.run2('DELETE FROM inventario_ayb WHERE id=$1', [req.params.id]);
  res.redirect('/inventario?msg=eliminado');
});

module.exports = router;
