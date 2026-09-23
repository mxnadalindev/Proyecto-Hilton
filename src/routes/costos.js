const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido, requiereDepartamento } = require('./middleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
router.use(loginRequerido, requiereDepartamento('/costos'));
const { analizarFactura, mensajeErrorGemini } = require('../services/gemini');

// Costos ahora es compartido entre Cocina y AYB (antes era solo de Cocina):
// cada departamento ve y carga sus propios platos/tragos/menús, sin
// mezclarse con los del otro — pero los dos usan la MISMA lista de
// insumos/precios, a propósito (ver comentario en database.js).
//
// Una cuenta de departamento (usuario.departamento === 'cocina' o 'ayb')
// siempre ve lo suyo. Un admin general (sin departamento, o "sistema") no
// tiene uno propio — por default ve Cocina, igual que se comportaba esta
// pantalla antes de este cambio, y puede pasar a ver AYB agregando
// "?depto=ayb" a la URL (la vista le muestra un link para cambiar).
function departamentoEfectivo(req) {
  const d = (req.session.usuario?.departamento || '').toLowerCase();
  if (d === 'cocina' || d === 'ayb') return d;
  return req.query.depto === 'ayb' ? 'ayb' : 'cocina';
}
const { parsearCsvInsumos, importarInsumos, importarProductosAyb } = require('../services/importadorInsumos');
const { parsearCsvPlatos, importarPlatos } = require('../services/importadorPlatos');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, 'factura_'+Date.now()+path.extname(file.originalname))
});
const upload = multer({ storage, limits:{fileSize:10*1024*1024} });

const storageCsv = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, 'insumos_'+Date.now()+path.extname(file.originalname))
});
const uploadCsv = multer({ storage: storageCsv, limits:{fileSize:30*1024*1024} }); // hasta 30MB, sobra para miles de filas de texto

// Períodos permitidos para la Variación de precios (en días)
const PERIODOS_VARIACION = [7, 14, 21, 28];
const LIMITE_VARIACION = 10;

// Calcula el top de insumos según el modo elegido:
// - 'subieron' / 'bajaron' / 'iguales': compara contra el precio de hace N días (historial_precios)
// - 'caros': ordena todos los insumos por precio actual, sin importar si cambiaron
async function calcularVariacionPrecios(dias, tipo) {
  if (tipo === 'caros') {
    return await db.all2(`
      SELECT id, nombre, codigo, categoria, unidad,
             precio_unitario AS precio_actual,
             NULL AS precio_inicio, NULL AS variacion_abs, NULL AS variacion_pct
      FROM insumos
      WHERE precio_unitario > 0
      ORDER BY precio_unitario DESC
      LIMIT $1
    `, [LIMITE_VARIACION]);
  }

  const filas = await db.all2(`
    WITH primero AS (
      SELECT DISTINCT ON (insumo_id) insumo_id, precio_anterior AS precio_inicio
      FROM historial_precios
      WHERE fecha >= NOW() - ($1 || ' days')::interval
      ORDER BY insumo_id, fecha ASC
    )
    SELECT i.id, i.nombre, i.codigo, i.categoria, i.unidad,
           i.precio_unitario AS precio_actual,
           p.precio_inicio,
           (i.precio_unitario - p.precio_inicio) AS variacion_abs,
           CASE WHEN p.precio_inicio > 0
                THEN ROUND((((i.precio_unitario - p.precio_inicio) / p.precio_inicio) * 100)::numeric, 1)
                ELSE NULL END AS variacion_pct
    FROM primero p
    JOIN insumos i ON i.id = p.insumo_id
    ORDER BY variacion_pct ${tipo === 'bajaron' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST'}
  `, [dias]);

  if (tipo === 'iguales') {
    return filas.filter(f => Math.abs(f.variacion_abs) < 0.01).slice(0, LIMITE_VARIACION);
  } else if (tipo === 'bajaron') {
    return filas.filter(f => f.variacion_abs < -0.01).slice(0, LIMITE_VARIACION);
  } else {
    return filas.filter(f => f.variacion_abs > 0.01).slice(0, LIMITE_VARIACION);
  }
}

// Búsqueda en vivo de insumos (mientras el usuario escribe, sin Enter).
// Existe por separado de GET '/' porque la pantalla principal solo carga
// los primeros 200 insumos por defecto (para no traer toda la tabla de
// una), así que filtrar en el navegador contra lo que ya está en pantalla
// se quedaba corto: un insumo que no entrara en esos primeros 200 (por
// orden de categoría/nombre) no aparecía nunca, aunque existiera. Esta
// ruta sí consulta TODA la tabla, igual que la búsqueda con Enter de
// siempre, solo que devuelve JSON en vez de renderizar la página entera.
// Columnas de productos_ayb "disfrazadas" con los mismos nombres que usa la
// tabla insumos (codigo, unidad) — así la vista y el resto de esta ruta
// pueden tratar ambas listas de la misma manera sin tener que duplicar el EJS.
const SELECT_PRODUCTOS_AYB_COMO_INSUMO =
  "id, nombre, categoria, codigo_barras AS codigo, unidad_default AS unidad, precio_unitario, stock_actual, proveedor";

router.get('/insumos/buscar-vivo', loginRequerido, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ insumos: [] });
  const esAyb = departamentoEfectivo(req) === 'ayb';
  const insumos = esAyb
    ? await db.all2(
        `SELECT id, codigo_barras AS codigo, nombre, precio_unitario FROM productos_ayb
         WHERE activo=true AND (nombre ILIKE $1 OR codigo_barras ILIKE $1) ORDER BY categoria NULLS LAST, nombre LIMIT 200`,
        [`%${q}%`]
      )
    : await db.all2(
        "SELECT id, codigo, nombre, precio_unitario FROM insumos WHERE nombre ILIKE $1 OR codigo ILIKE $1 ORDER BY categoria, nombre LIMIT 200",
        [`%${q}%`]
      );
  res.json({ insumos, esAyb });
});

// Mismo patrón que /insumos/buscar-vivo: búsqueda en vivo de platos/tragos
// para el modal de "Costeo de platos", sin recargar la página completa.
router.get('/platos/buscar-vivo', loginRequerido, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ platos: [] });
  const depto = departamentoEfectivo(req);
  const platos = await db.all2(
    "SELECT * FROM platos_costo WHERE departamento=$1 AND nombre ILIKE $2 ORDER BY nombre LIMIT 300",
    [depto, `%${q}%`]
  );
  res.json({ platos });
});

function estilizarTituloExcel(ws, rango, texto) {
  ws.mergeCells(rango);
  const titulo = ws.getCell(rango.split(':')[0]);
  titulo.value = texto;
  titulo.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  titulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  titulo.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;
}
function estilizarEncabezadoExcel(row) {
  row.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  row.height = 22;
}

// Exportar a Excel la lista completa de insumos/productos (con precio),
// mismo patrón que ya usan Horas Extra y Personal ("Otras opciones" →
// Excel). Trae TODOS los insumos, no solo los primeros 200 que se ven en
// pantalla por defecto.
router.get('/insumos/excel', loginRequerido, async (req, res) => {
  try {
    const esAyb = departamentoEfectivo(req) === 'ayb';
    const insumos = esAyb
      ? await db.all2(`SELECT ${SELECT_PRODUCTOS_AYB_COMO_INSUMO} FROM productos_ayb WHERE activo=true ORDER BY categoria NULLS LAST, nombre`)
      : await db.all2("SELECT * FROM insumos ORDER BY categoria, nombre");

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Insumos');
    estilizarTituloExcel(ws, 'A1:D1', `INSUMOS / INGREDIENTES — ${esAyb ? 'AYB' : 'COCINA'}`);
    estilizarEncabezadoExcel(ws.addRow(['CÓDIGO', 'INSUMO', 'CATEGORÍA', 'PRECIO UNITARIO']));
    insumos.forEach(ins => {
      const row = ws.addRow([ins.codigo || '', ins.nombre, ins.categoria || '', Number(ins.precio_unitario) || 0]);
      row.eachCell((c, col) => {
        c.font = { size: 10 };
        c.alignment = { horizontal: col === 2 ? 'left' : 'center', vertical: 'middle' };
        c.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
        if (col === 4) c.numFmt = '"$"#,##0.00';
      });
    });
    ws.columns = [{ width: 14 }, { width: 34 }, { width: 20 }, { width: 16 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=insumos_${esAyb ? 'ayb' : 'cocina'}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exportando insumos a Excel:', err.message);
    res.status(500).render('error', { mensaje: 'No se pudo generar el Excel de insumos.', volver: '/costos' });
  }
});

// Exportar a Excel el costeo completo de platos/tragos (costo, margen,
// precio de venta) — mismo criterio que insumos/excel.
router.get('/platos/excel', loginRequerido, async (req, res) => {
  try {
    const depto = departamentoEfectivo(req);
    const esAyb = depto === 'ayb';
    const platos = await db.all2("SELECT * FROM platos_costo WHERE departamento=$1 ORDER BY nombre", [depto]);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Costeo');
    estilizarTituloExcel(ws, 'A1:E1', `COSTEO DE ${esAyb ? 'TRAGOS' : 'PLATOS'} — ${esAyb ? 'AYB' : 'COCINA'}`);
    estilizarEncabezadoExcel(ws.addRow([(esAyb ? 'TRAGO' : 'PLATO').toUpperCase(), 'CATEGORÍA', 'COSTO', 'MARGEN %', 'PRECIO VENTA']));
    platos.forEach(p => {
      const costo = parseFloat(p.costo_total) || 0;
      const margen = parseFloat(p.margen_ganancia) || 0;
      const precioVenta = costo * (1 + margen / 100);
      const row = ws.addRow([p.nombre, p.categoria || '', costo, margen / 100, precioVenta]);
      row.eachCell((c, col) => {
        c.font = { size: 10 };
        c.alignment = { horizontal: col === 1 ? 'left' : 'center', vertical: 'middle' };
        c.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
        if (col === 3 || col === 5) c.numFmt = '"$"#,##0.00';
        if (col === 4) c.numFmt = '0.0%';
      });
    });
    ws.columns = [{ width: 30 }, { width: 20 }, { width: 14 }, { width: 12 }, { width: 16 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=costeo_${esAyb ? 'tragos_ayb' : 'platos_cocina'}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exportando costeo a Excel:', err.message);
    res.status(500).render('error', { mensaje: 'No se pudo generar el Excel de costeo.', volver: '/costos' });
  }
});

router.get('/', loginRequerido, async (req, res) => {
  const buscar = (req.query.buscar || '').trim();
  const letra  = (req.query.letra || '').trim().toUpperCase().slice(0, 1);
  const LIMITE_SIN_BUSQUEDA = 200;

  const depto = departamentoEfectivo(req);
  const esAyb = depto === 'ayb';
  const esAdminGeneral = !['cocina', 'ayb'].includes((req.session.usuario?.departamento || '').toLowerCase());

  // ── Insumos/Ingredientes: para Cocina es la tabla "insumos" de siempre.
  //    Para AYB, pasan a ser los productos de Inventario AYB (misma lista,
  //    un solo lugar donde se cargan) — no una lista aparte para Costos.
  //
  // totalInsumos SIEMPRE es el total real de la tabla (filtrando o no) —
  // antes, al buscar o filtrar por letra, esta variable pasaba a valer
  // "cuántos insumos matchean el filtro" en vez del total real, y como es
  // la misma variable que arma la tarjeta de resumen ("N insumos
  // cargados"), si alguien filtraba por una letra y se iba sin limpiar el
  // filtro, esa tarjeta quedaba mostrando un número mucho más chico que el
  // real (parecía que "se habían perdido" insumos, cuando en realidad
  // seguían todos ahí). resultadosInsumos es aparte: solo se usa para el
  // cartelito "X resultados para ..." adentro del buscador.
  let insumos, resultadosInsumos;
  const totalInsumosRow = esAyb
    ? await db.get2("SELECT COUNT(*)::int AS total FROM productos_ayb WHERE activo=true")
    : await db.get2("SELECT COUNT(*)::int AS total FROM insumos");
  const totalInsumos = totalInsumosRow?.total || 0;
  if (esAyb) {
    if (buscar) {
      insumos = await db.all2(
        `SELECT ${SELECT_PRODUCTOS_AYB_COMO_INSUMO} FROM productos_ayb WHERE activo=true AND (nombre ILIKE $1 OR codigo_barras ILIKE $1) ORDER BY categoria NULLS LAST, nombre LIMIT 500`,
        [`%${buscar}%`]
      );
      resultadosInsumos = insumos.length;
    } else if (letra) {
      insumos = await db.all2(
        `SELECT ${SELECT_PRODUCTOS_AYB_COMO_INSUMO} FROM productos_ayb WHERE activo=true AND nombre ILIKE $1 ORDER BY nombre LIMIT 500`,
        [`${letra}%`]
      );
      resultadosInsumos = insumos.length;
    } else {
      insumos = await db.all2(
        `SELECT ${SELECT_PRODUCTOS_AYB_COMO_INSUMO} FROM productos_ayb WHERE activo=true ORDER BY categoria NULLS LAST, nombre LIMIT $1`,
        [LIMITE_SIN_BUSQUEDA]
      );
      resultadosInsumos = totalInsumos;
    }
  } else if (buscar) {
    insumos = await db.all2(
      "SELECT * FROM insumos WHERE nombre ILIKE $1 OR codigo ILIKE $1 ORDER BY categoria, nombre LIMIT 500",
      [`%${buscar}%`]
    );
    resultadosInsumos = insumos.length;
  } else if (letra) {
    insumos = await db.all2(
      "SELECT * FROM insumos WHERE nombre ILIKE $1 ORDER BY nombre LIMIT 500",
      [`${letra}%`]
    );
    resultadosInsumos = insumos.length;
  } else {
    insumos = await db.all2(
      "SELECT * FROM insumos ORDER BY categoria, nombre LIMIT $1",
      [LIMITE_SIN_BUSQUEDA]
    );
    resultadosInsumos = totalInsumos;
  }

  // ── Costeo de platos/tragos: cada departamento ve los suyos
  //    (platos_costo.departamento). AYB los llama "tragos" en la vista,
  //    pero es la misma tabla y las mismas consultas que Cocina.
  // Mismo criterio que con insumos: totalPlatos es SIEMPRE el total real
  // (sirve para la tarjeta de resumen), resultadosPlatos es el conteo de
  // la búsqueda/filtro actual (sirve para el cartelito de resultados).
  const buscarPlato = (req.query.buscarPlato || '').trim();
  const letraPlato  = (req.query.letraPlato || '').trim().toUpperCase().slice(0, 1);
  const totalPlatosRow = await db.get2("SELECT COUNT(*)::int AS total FROM platos_costo WHERE departamento=$1", [depto]);
  const totalPlatos = totalPlatosRow?.total || 0;
  let platos = [], resultadosPlatos = totalPlatos;
  if (buscarPlato) {
    platos = await db.all2("SELECT * FROM platos_costo WHERE departamento=$1 AND nombre ILIKE $2 ORDER BY nombre LIMIT 300", [depto, `%${buscarPlato}%`]);
    resultadosPlatos = platos.length;
  } else if (letraPlato) {
    platos = await db.all2("SELECT * FROM platos_costo WHERE departamento=$1 AND nombre ILIKE $2 ORDER BY nombre LIMIT 300", [depto, `${letraPlato}%`]);
    resultadosPlatos = platos.length;
  } else {
    platos = await db.all2("SELECT * FROM platos_costo WHERE departamento=$1 ORDER BY nombre LIMIT 300", [depto]);
  }
  const categorias = [...new Set(insumos.map(i=>i.categoria))];
  const msg = req.query.msg || null;
  const geminiConfigurado = !!process.env.GEMINI_API_KEY;

  // ── Variación de precios: compara el precio actual de cada insumo/producto
  //    contra el precio que tenía al INICIO del período elegido. Para AYB
  //    corre sobre productos_ayb + historial_precios_ayb; para Cocina, igual
  //    que siempre, sobre insumos + historial_precios.
  const DIAS_PERMITIDOS = [7, 14, 21, 28];
  const diasVariacion = DIAS_PERMITIDOS.includes(parseInt(req.query.dias)) ? parseInt(req.query.dias) : 7;
  const tipoVariacion = ['subieron', 'bajaron', 'iguales'].includes(req.query.tipoVariacion)
    ? req.query.tipoVariacion : 'subieron';

  const variacionPrecios = esAyb
    ? await calcularVariacionPreciosAyb(diasVariacion, tipoVariacion, 10)
    : await calcularVariacionPrecios(diasVariacion, tipoVariacion, 10);

  res.render('costos', {
    insumos, platos, categorias, msg, geminiConfigurado,
    buscar, letra, totalInsumos, resultadosInsumos,
    buscarPlato, totalPlatos, letraPlato, resultadosPlatos,
    mostrandoLimitado: !buscar && totalInsumos > LIMITE_SIN_BUSQUEDA,
    limiteSinBusqueda: LIMITE_SIN_BUSQUEDA,
    variacionPrecios, diasVariacion, tipoVariacion,
    mostrarModalVariacion: req.query.dias !== undefined || req.query.tipoVariacion !== undefined,
    depto, esAdminGeneral, esAyb
  });
});

// Calcula el top de insumos que subieron / bajaron / se mantuvieron en un período.
// Se usa tanto para mostrar el modal como para armar el Excel de descarga.
async function calcularVariacionPrecios(diasVariacion, tipoVariacion, limite) {
  const filasVariacion = await db.all2(`
    WITH primero AS (
      SELECT DISTINCT ON (insumo_id) insumo_id, precio_anterior AS precio_inicio
      FROM historial_precios
      WHERE fecha >= NOW() - ($1 || ' days')::interval
      ORDER BY insumo_id, fecha ASC
    )
    SELECT i.id, i.nombre, i.codigo, i.categoria, i.unidad,
           i.precio_unitario AS precio_actual,
           p.precio_inicio,
           (i.precio_unitario - p.precio_inicio) AS variacion_abs,
           CASE WHEN p.precio_inicio > 0
                THEN ROUND((((i.precio_unitario - p.precio_inicio) / p.precio_inicio) * 100)::numeric, 1)
                ELSE 0 END AS variacion_pct
    FROM primero p
    JOIN insumos i ON i.id = p.insumo_id
    ORDER BY variacion_pct ${tipoVariacion === 'bajaron' ? 'ASC' : 'DESC'}
  `, [diasVariacion]);

  if (tipoVariacion === 'iguales') {
    return filasVariacion.filter(f => Math.abs(f.variacion_abs) < 0.01).slice(0, limite);
  } else if (tipoVariacion === 'bajaron') {
    return filasVariacion.filter(f => f.variacion_abs < -0.01).slice(0, limite);
  }
  return filasVariacion.filter(f => f.variacion_abs > 0.01).slice(0, limite);
}

// Igual que calcularVariacionPrecios, pero para los productos de AYB
// (productos_ayb + historial_precios_ayb) en vez de insumos de Cocina.
async function calcularVariacionPreciosAyb(diasVariacion, tipoVariacion, limite) {
  const filasVariacion = await db.all2(`
    WITH primero AS (
      SELECT DISTINCT ON (producto_id) producto_id, precio_anterior AS precio_inicio
      FROM historial_precios_ayb
      WHERE fecha >= NOW() - ($1 || ' days')::interval
      ORDER BY producto_id, fecha ASC
    )
    SELECT pr.id, pr.nombre, pr.codigo_barras AS codigo, pr.categoria, pr.unidad_default AS unidad,
           pr.precio_unitario AS precio_actual,
           p.precio_inicio,
           (pr.precio_unitario - p.precio_inicio) AS variacion_abs,
           CASE WHEN p.precio_inicio > 0
                THEN ROUND((((pr.precio_unitario - p.precio_inicio) / p.precio_inicio) * 100)::numeric, 1)
                ELSE 0 END AS variacion_pct
    FROM primero p
    JOIN productos_ayb pr ON pr.id = p.producto_id
    ORDER BY variacion_pct ${tipoVariacion === 'bajaron' ? 'ASC' : 'DESC'}
  `, [diasVariacion]);

  if (tipoVariacion === 'iguales') {
    return filasVariacion.filter(f => Math.abs(f.variacion_abs) < 0.01).slice(0, limite);
  } else if (tipoVariacion === 'bajaron') {
    return filasVariacion.filter(f => f.variacion_abs < -0.01).slice(0, limite);
  }
  return filasVariacion.filter(f => f.variacion_abs > 0.01).slice(0, limite);
}

// Descarga en Excel la misma tabla que se ve en el modal de Variación de precios
router.get('/variacion-excel', loginRequerido, async (req, res) => {
  const DIAS_PERMITIDOS = [7, 14, 21, 28];
  const diasVariacion = DIAS_PERMITIDOS.includes(parseInt(req.query.dias)) ? parseInt(req.query.dias) : 7;
  const tipoVariacion = ['subieron', 'bajaron', 'iguales'].includes(req.query.tipoVariacion)
    ? req.query.tipoVariacion : 'subieron';

  const esAyb = departamentoEfectivo(req) === 'ayb';
  const filas = esAyb
    ? await calcularVariacionPreciosAyb(diasVariacion, tipoVariacion, 10)
    : await calcularVariacionPrecios(diasVariacion, tipoVariacion, 10);
  const NOMBRE_TIPO = { subieron: 'Subieron', bajaron: 'Bajaron', iguales: 'Se mantuvieron' };

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Variación de precios');

  ws.mergeCells('A1:E1');
  const titulo = ws.getCell('A1');
  titulo.value = `VARIACIÓN DE PRECIOS — ${NOMBRE_TIPO[tipoVariacion].toUpperCase()} — últimos ${diasVariacion} días`;
  titulo.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  titulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  titulo.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  const encRow = ws.addRow(['Insumo', 'Categoría', 'Precio antes', 'Precio actual', 'Variación %', 'Variación $']);
  encRow.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  filas.forEach(f => {
    const row = ws.addRow([
      f.nombre, f.categoria || '',
      parseFloat(f.precio_inicio), parseFloat(f.precio_actual),
      parseFloat(f.variacion_pct), parseFloat(f.variacion_abs)
    ]);
    row.eachCell((c, col) => {
      c.font = { size: 10 };
      c.alignment = { horizontal: col === 1 || col === 2 ? 'left' : 'center', vertical: 'middle' };
      if (col >= 3 && col <= 4) c.numFmt = '"$"#,##0.00';
      if (col === 5) c.numFmt = '+0.0"%";-0.0"%"';
      if (col === 6) c.numFmt = '+"$"#,##0.00;-"$"#,##0.00';
      if (col === 5 || col === 6) {
        c.font.bold = true;
        c.font.color = { argb: parseFloat(f.variacion_abs) > 0 ? 'FFDC2626' : (parseFloat(f.variacion_abs) < 0 ? 'FF16A34A' : 'FF64748B') };
      }
    });
  });

  ws.columns = [{ width: 28 }, { width: 18 }, { width: 14 }, { width: 14 }, { width: 13 }, { width: 13 }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=variacion_precios_${tipoVariacion}_${diasVariacion}d.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

router.post('/insumo/nuevo', loginRequerido, async (req, res) => {
  const { nombre, categoria, unidad, precio_unitario, stock_actual, proveedor, codigo } = req.body;
  try {
    await db.run2(
      "INSERT INTO insumos (nombre,categoria,unidad,precio_unitario,stock_actual,proveedor,codigo) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [nombre, categoria||'General', unidad||'kg', parseFloat(precio_unitario)||0, parseFloat(stock_actual)||0, proveedor||'', codigo||null]
    );
    res.redirect('/costos');
  } catch (e) {
    console.error('Error creando insumo:', e.message);
    res.redirect('/costos?msg=' + encodeURIComponent(e.message.includes('idx_insumos_codigo_unico') ? 'Ya existe un insumo con ese código.' : 'Error al crear el insumo.'));
  }
});

router.post('/insumo/:id/precio', loginRequerido, async (req, res) => {
  const insumo = await db.get2("SELECT * FROM insumos WHERE id=$1", [req.params.id]);
  if (insumo) {
    const precioActual = parseFloat(insumo.precio_unitario) || 0;
    const precioNuevo = parseFloat(req.body.precio_nuevo);
    const forzar = req.body.forzar_menor === '1';

    if (isNaN(precioNuevo) || precioNuevo <= 0) {
      return res.redirect('/costos?msg=' + encodeURIComponent('El precio ingresado no es válido.'));
    }

    // Regla: el precio de costo nunca baja solo — así el costeo de los platos
    // siempre queda con el valor más alto conocido, como margen de seguridad.
    // Se puede forzar a la baja tildando "Forzar" cuando es una corrección real.
    if (precioNuevo < precioActual && !forzar) {
      return res.redirect('/costos?msg=' + encodeURIComponent(
        `El precio ingresado ($${precioNuevo.toFixed(2)}) es menor al actual ($${precioActual.toFixed(2)}) — no se aplicó. Se mantiene el más alto. Si es una corrección real, tildá "Forzar" y guardá de nuevo.`
      ));
    }

    if (Math.abs(precioNuevo - precioActual) > 0.001) {
      await db.run2("INSERT INTO historial_precios (insumo_id,precio_anterior,precio_nuevo,origen) VALUES ($1,$2,$3,'manual')",
        [insumo.id, precioActual, precioNuevo]);
      await db.run2("UPDATE insumos SET precio_unitario=$1,actualizado_en=NOW() WHERE id=$2",
        [precioNuevo, req.params.id]);
      await recalcularPlatos(insumo.id);
    }
  }
  res.redirect('/costos');
});

// Actualiza el precio de un producto de AYB (Inventario AYB) desde Costos —
// igual mecánica que /insumo/:id/precio (el precio nunca baja solo, salvo
// que se tilde "Forzar"), pero sobre productos_ayb/historial_precios_ayb en
// vez de insumos/historial_precios. También recalcula en cascada los tragos
// que usan este producto como ingrediente (plato_insumos_ayb).
router.post('/producto-ayb/:id/precio', loginRequerido, async (req, res) => {
  const producto = await db.get2("SELECT * FROM productos_ayb WHERE id=$1", [req.params.id]);
  if (producto) {
    const precioActual = parseFloat(producto.precio_unitario) || 0;
    const precioNuevo = parseFloat(req.body.precio_nuevo);
    const forzar = req.body.forzar_menor === '1';
    const volverAyb = '/costos?depto=ayb';

    if (isNaN(precioNuevo) || precioNuevo <= 0) {
      return res.redirect(volverAyb + '&msg=' + encodeURIComponent('El precio ingresado no es válido.'));
    }

    if (precioNuevo < precioActual && !forzar) {
      return res.redirect(volverAyb + '&msg=' + encodeURIComponent(
        `El precio ingresado ($${precioNuevo.toFixed(2)}) es menor al actual ($${precioActual.toFixed(2)}) — no se aplicó. Se mantiene el más alto. Si es una corrección real, tildá "Forzar" y guardá de nuevo.`
      ));
    }

    if (Math.abs(precioNuevo - precioActual) > 0.001) {
      await db.run2("INSERT INTO historial_precios_ayb (producto_id,precio_anterior,precio_nuevo,origen) VALUES ($1,$2,$3,'manual')",
        [producto.id, precioActual, precioNuevo]);
      await db.run2("UPDATE productos_ayb SET precio_unitario=$1 WHERE id=$2",
        [precioNuevo, req.params.id]);
      await recalcularPlatosAyb(producto.id);
    }
  }
  res.redirect('/costos?depto=ayb');
});

router.post('/insumo/:id/eliminar', loginRequerido, async (req, res) => {
  await db.run2("DELETE FROM plato_insumos WHERE insumo_id=$1", [req.params.id]);
  await db.run2("DELETE FROM insumos WHERE id=$1", [req.params.id]);
  res.redirect('/costos');
});

router.post('/plato/nuevo', loginRequerido, async (req, res) => {
  const { nombre, categoria, porciones, precio_venta, margen_ganancia } = req.body;
  const depto = departamentoEfectivo(req);
  const resultado = await db.run2(
    "INSERT INTO platos_costo (nombre,categoria,porciones,precio_venta,margen_ganancia,departamento) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [nombre, categoria||'', parseInt(porciones)||1, parseFloat(precio_venta)||0, parseFloat(margen_ganancia)||30, depto]
  );
  if (resultado && resultado.lastID) {
    // Va directo a la pantalla del trago/plato recién creado (que ya tiene
    // el formulario de "Agregar ingrediente") pero sin mostrar todavía
    // ningún cartel de "creado" — el cartel aparece recién cuando el
    // usuario terminó de cargar los ingredientes y apretó "Guardar" (ver
    // ruta /plato/:id/guardar más abajo).
    res.redirect('/costos/plato/' + resultado.lastID);
  } else {
    res.redirect('/costos' + (depto === 'ayb' ? '?depto=ayb' : ''));
  }
});

// Botón "Guardar" de la pantalla de detalle: no cambia ningún dato (los
// campos de esa pantalla ya se guardan solos, como el margen), pero le
// confirma al usuario con un cartel propio que el trago/plato quedó
// guardado, y lo devuelve a la lista de Costos — así el flujo completo es
// crear → cargar ingredientes → Guardar → confirmación → vuelta a la lista.
router.post('/plato/:id/guardar', loginRequerido, async (req, res) => {
  const plato = await db.get2("SELECT id, departamento FROM platos_costo WHERE id=$1", [req.params.id]);
  if (!plato) return res.redirect('/costos');
  const esAybGuardado = plato.departamento === 'ayb';
  res.redirect('/costos' + (esAybGuardado ? '?depto=ayb&guardado=1' : '?guardado=1'));
});

// Un plato de Cocina y un trago de AYB viven en la misma fila de
// platos_costo (ver comentario en database.js), así que las rutas de acá
// para abajo se ramifican leyendo plato.departamento en vez de duplicarse
// en un archivo aparte — Cocina sigue apuntando a insumos/plato_insumos,
// AYB pasa a apuntar a productos_ayb/plato_insumos_ayb.
router.get('/plato/:id', loginRequerido, async (req, res) => {
  const plato = await db.get2("SELECT * FROM platos_costo WHERE id=$1", [req.params.id]);
  if (!plato) return res.redirect('/costos');
  const esAyb = plato.departamento === 'ayb';

  const ingredientes = esAyb
    ? await db.all2(`
        SELECT pi.*, pr.nombre as insumo_nombre, pr.precio_unitario, pr.unidad_default
        FROM plato_insumos_ayb pi JOIN productos_ayb pr ON pi.insumo_id=pr.id WHERE pi.plato_id=$1
      `, [req.params.id])
    : await db.all2(`
        SELECT pi.*,i.nombre as insumo_nombre,i.precio_unitario
        FROM plato_insumos pi JOIN insumos i ON pi.insumo_id=i.id WHERE pi.plato_id=$1
      `, [req.params.id]);

  const todosInsumos = esAyb
    ? await db.all2("SELECT id, nombre, categoria, precio_unitario, unidad_default AS unidad FROM productos_ayb WHERE activo=true ORDER BY categoria NULLS LAST, nombre")
    : await db.all2("SELECT * FROM insumos ORDER BY categoria NULLS LAST, nombre");

  const historial = esAyb
    ? await db.all2(`
        SELECT hp.*, pr.nombre as insumo_nombre FROM historial_precios_ayb hp
        JOIN productos_ayb pr ON hp.producto_id=pr.id ORDER BY hp.fecha DESC LIMIT 20
      `)
    : await db.all2(`
        SELECT hp.*,i.nombre as insumo_nombre FROM historial_precios hp
        JOIN insumos i ON hp.insumo_id=i.id ORDER BY hp.fecha DESC LIMIT 20
      `);

  res.render('costos_plato', { plato, ingredientes, todosInsumos, historial, esAyb });
});

router.post('/plato/:id/insumo', loginRequerido, async (req, res) => {
  const { insumo_id, cantidad, unidad } = req.body;
  const plato = await db.get2("SELECT departamento FROM platos_costo WHERE id=$1", [req.params.id]);
  if (!plato) return res.redirect('/costos');

  if (plato.departamento === 'ayb') {
    const producto = await db.get2("SELECT * FROM productos_ayb WHERE id=$1", [insumo_id]);
    if (producto) {
      const costo_parcial = parseFloat(cantidad)*producto.precio_unitario;
      await db.run2(
        "INSERT INTO plato_insumos_ayb (plato_id,insumo_id,cantidad,unidad,costo_parcial) VALUES ($1,$2,$3,$4,$5)",
        [req.params.id, insumo_id, parseFloat(cantidad), unidad||producto.unidad_default, costo_parcial]
      );
      await recalcularCostoPlato(req.params.id);
    }
  } else {
    const insumo = await db.get2("SELECT * FROM insumos WHERE id=$1", [insumo_id]);
    if (insumo) {
      const costo_parcial = parseFloat(cantidad)*insumo.precio_unitario;
      await db.run2(
        "INSERT INTO plato_insumos (plato_id,insumo_id,cantidad,unidad,costo_parcial) VALUES ($1,$2,$3,$4,$5)",
        [req.params.id, insumo_id, parseFloat(cantidad), unidad||insumo.unidad, costo_parcial]
      );
      await recalcularCostoPlato(req.params.id);
    }
  }
  res.redirect('/costos/plato/'+req.params.id);
});

router.post('/plato/:plato_id/insumo/:id/eliminar', loginRequerido, async (req, res) => {
  const plato = await db.get2("SELECT departamento FROM platos_costo WHERE id=$1", [req.params.plato_id]);
  if (plato?.departamento === 'ayb') {
    await db.run2("DELETE FROM plato_insumos_ayb WHERE id=$1", [req.params.id]);
  } else {
    await db.run2("DELETE FROM plato_insumos WHERE id=$1", [req.params.id]);
  }
  await recalcularCostoPlato(req.params.plato_id);
  res.redirect('/costos/plato/'+req.params.plato_id);
});

router.post('/plato/:plato_id/insumo/:id/cantidad', loginRequerido, async (req, res) => {
  const nuevaCantidad = parseFloat(req.body.cantidad);
  try {
    const plato = await db.get2("SELECT departamento FROM platos_costo WHERE id=$1", [req.params.plato_id]);
    const esAyb = plato?.departamento === 'ayb';
    const tablaLinea  = esAyb ? 'plato_insumos_ayb' : 'plato_insumos';
    const tablaInsumo = esAyb ? 'productos_ayb' : 'insumos';

    const item = await db.get2(`SELECT * FROM ${tablaLinea} WHERE id=$1`, [req.params.id]);
    if (item && !isNaN(nuevaCantidad) && nuevaCantidad >= 0) {
      const insumo = await db.get2(`SELECT * FROM ${tablaInsumo} WHERE id=$1`, [item.insumo_id]);
      const costo_parcial = nuevaCantidad * (parseFloat(insumo?.precio_unitario) || 0);
      await db.run2(
        `UPDATE ${tablaLinea} SET cantidad=$1, costo_parcial=$2 WHERE id=$3`,
        [nuevaCantidad, costo_parcial, req.params.id]
      );
      await recalcularCostoPlato(req.params.plato_id);
    }
  } catch (e) {
    console.error('Error actualizando cantidad:', e.message);
  }
  res.redirect('/costos/plato/'+req.params.plato_id);
});

router.post('/plato/:id/margen', loginRequerido, async (req, res) => {
  const nuevoMargen = parseFloat(req.body.margen_ganancia);
  try {
    if (!isNaN(nuevoMargen) && nuevoMargen >= 0) {
      await db.run2("UPDATE platos_costo SET margen_ganancia=$1 WHERE id=$2", [nuevoMargen, req.params.id]);
    }
  } catch (e) {
    console.error('Error actualizando margen de ganancia:', e.message);
  }
  res.redirect('/costos/plato/'+req.params.id);
});

router.post('/plato/:id/eliminar', loginRequerido, async (req, res) => {
  // Solo una de las dos tablas de líneas tiene filas para este plato (según
  // sea de Cocina o de AYB) — borrar de las dos sin preguntar es más simple
  // que ir a buscar el departamento primero, y no rompe nada de todos modos.
  await db.run2("DELETE FROM plato_insumos WHERE plato_id=$1", [req.params.id]);
  await db.run2("DELETE FROM plato_insumos_ayb WHERE plato_id=$1", [req.params.id]);
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
  const { insumo } = buscarMatchInsumo(nombreDetectado, insumos);
  return insumo;
}

// Igual que buscarInsumoMasParecido, pero además devuelve el score de
// confianza (0..1) del mejor candidato, se haya superado el umbral o no —
// lo necesitamos para poder mostrarle al usuario "qué tan seguro" está el
// sistema, y para decidir si conviene auto-aplicar el cambio o pedir
// confirmación. No reemplaza a buscarInsumoMasParecido (que sigue devolviendo
// lo mismo que antes), solo agrega el detalle del score.
function buscarMatchInsumo(nombreDetectado, insumos) {
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
  return { insumo: mejorScore >= UMBRAL ? mejor : null, score: mejorScore };
}

// A partir de qué confianza el sistema aplica el precio solo, sin pedirle
// confirmación al usuario. Por debajo de esto (pero por encima del umbral de
// "hay match" de arriba) se le muestra al usuario para que confirme a mano.
const UMBRAL_AUTO_APLICAR = 0.90;

// Aplica UN cambio de precio ya decidido (auto o confirmado a mano), dejando
// registro completo en historial_precios y recalculando los platos afectados.
// Centralizado acá para que la auto-aplicación y la confirmación manual
// graben exactamente los mismos datos, sin duplicar la lógica.
async function aplicarCambioPrecio({ insumoId, precioAnterior, precioNuevo, proveedor, facturaReferencia, usuario, confianza, automatico, esAyb }) {
  if (esAyb) {
    // Igual mecánica, pero sobre productos_ayb/historial_precios_ayb, con
    // su propia cascada hacia los tragos que usan este producto.
    await db.run2(
      `INSERT INTO historial_precios_ayb
        (producto_id, precio_anterior, precio_nuevo, origen, proveedor, factura_referencia, usuario_id, usuario_nombre, confianza_match, aplicado_automaticamente)
       VALUES ($1,$2,$3,'gemini',$4,$5,$6,$7,$8,$9)`,
      [insumoId, precioAnterior, precioNuevo, proveedor || null, facturaReferencia || null,
       usuario?.id || null, usuario?.nombre || null, confianza != null ? confianza : null, !!automatico]
    );
    await db.run2("UPDATE productos_ayb SET precio_unitario=$1 WHERE id=$2", [precioNuevo, insumoId]);
    await recalcularPlatosAyb(insumoId);
    return;
  }
  await db.run2(
    `INSERT INTO historial_precios
      (insumo_id, precio_anterior, precio_nuevo, origen, proveedor, factura_referencia, usuario_id, usuario_nombre, confianza_match, aplicado_automaticamente)
     VALUES ($1,$2,$3,'gemini',$4,$5,$6,$7,$8,$9)`,
    [insumoId, precioAnterior, precioNuevo, proveedor || null, facturaReferencia || null,
     usuario?.id || null, usuario?.nombre || null, confianza != null ? confianza : null, !!automatico]
  );
  await db.run2("UPDATE insumos SET precio_unitario=$1,actualizado_en=NOW() WHERE id=$2", [precioNuevo, insumoId]);
  await recalcularPlatos(insumoId);
}

// 1) Sube la foto, la manda a Gemini, matchea contra los insumos existentes,
//    auto-aplica lo que tiene confianza alta y deja el resto pendiente de revisión.
router.post('/factura', loginRequerido, upload.single('factura'), async (req, res) => {
  if (!req.file) return res.redirect('/costos?msg=' + encodeURIComponent('No se recibió ninguna imagen.'));

  try {
    // Hash del archivo, para detectar si esta misma factura ya se procesó antes.
    const hashArchivo = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
    const yaProcesada = await db.get2(
      "SELECT id, procesado_en, usuario_nombre FROM facturas_procesadas WHERE hash_archivo=$1 ORDER BY procesado_en DESC LIMIT 1",
      [hashArchivo]
    );

    const { tipoDocumento, proveedor, numeroFactura, items: itemsDetectados } = await analizarFactura(req.file.path, req.file.mimetype);

    if (tipoDocumento === 'nota_credito' || tipoDocumento === 'nota_debito') {
      const nombreTipo = tipoDocumento === 'nota_credito' ? 'Nota de Crédito' : 'Nota de Débito';
      return res.redirect('/costos?msg=' + encodeURIComponent(
        `La imagen parece ser una ${nombreTipo}, no una factura de compra — no se cargó ningún precio. Subí la factura original si querés actualizar precios.`
      ));
    }
    if (tipoDocumento === 'otro') {
      return res.redirect('/costos?msg=' + encodeURIComponent('No se reconoció la imagen como una factura de compra.'));
    }
    if (itemsDetectados.length === 0) {
      return res.redirect('/costos?msg=' + encodeURIComponent('No se pudo leer ningún ítem con precio válido en la factura.'));
    }

    const esAyb = departamentoEfectivo(req) === 'ayb';
    const insumos = esAyb
      ? await db.all2(`SELECT ${SELECT_PRODUCTOS_AYB_COMO_INSUMO} FROM productos_ayb WHERE activo=true`)
      : await db.all2("SELECT * FROM insumos");
    const usuario = req.session.usuario;
    const facturaReferencia = numeroFactura || null;

    let autoAplicados = 0;
    const pendientes = [];

    for (let i = 0; i < itemsDetectados.length; i++) {
      const item = itemsDetectados[i];
      const { insumo: match, score } = buscarMatchInsumo(item.nombre, insumos);

      // Si matcheó con un insumo existente, buscamos qué platos lo usan, para
      // poder avisarle al usuario qué platos se verían afectados por este
      // cambio de precio antes de que lo confirme (mismo dato que ya usa el
      // bot en "consultar_recetas_por_insumo", reutilizado acá para que la
      // pantalla de revisión muestre lo mismo sin tener que preguntarle al bot).
      // AYB no tiene platos armados, así que esto se salta directamente.
      let platosAfectados = [];
      if (match && !esAyb) {
        const rows = await db.all2(`
          SELECT p.nombre, p.costo_total
          FROM plato_insumos pi JOIN platos_costo p ON p.id = pi.plato_id
          WHERE pi.insumo_id = $1 ORDER BY p.nombre
        `, [match.id]);
        platosAfectados = rows.map(r => r.nombre);
      }

      const fila = {
        idx: i,
        nombre_detectado: item.nombre,
        cantidad: item.cantidad,
        unidad: item.unidad,
        precio_detectado: item.precio_unitario,
        insumo_id: match ? match.id : null,
        insumo_nombre: match ? match.nombre : null,
        precio_actual: match ? match.precio_unitario : null,
        sube: match ? item.precio_unitario > match.precio_unitario : null,
        confianza: match ? Math.round(score * 100) : null,
        platos_afectados: platosAfectados
      };

      const precioActual = match ? (parseFloat(match.precio_unitario) || 0) : null;
      const precioDetectado = parseFloat(item.precio_unitario);

      // Auto-aplicar solo si: hay match, la confianza es alta, el precio sube
      // o se mantiene (nunca baja precios solo), y esta factura NO es una
      // que ya procesamos antes (si es repetida, todo pasa a revisión manual
      // como capa extra de seguridad, aunque el match sea perfecto).
      const puedeAutoAplicar = match && score >= UMBRAL_AUTO_APLICAR && precioDetectado >= precioActual && !yaProcesada;

      if (puedeAutoAplicar) {
        if (Math.abs(precioDetectado - precioActual) > 0.001) {
          await aplicarCambioPrecio({
            insumoId: match.id, precioAnterior: precioActual, precioNuevo: precioDetectado,
            proveedor, facturaReferencia, usuario, confianza: score, automatico: true, esAyb
          });
        }
        autoAplicados++;
      } else {
        pendientes.push(fila);
      }
    }

    // Registramos que esta factura (por su hash) ya fue procesada, para
    // poder avisar si alguien la vuelve a subir sin querer.
    await db.run2(
      `INSERT INTO facturas_procesadas (hash_archivo, nombre_archivo, proveedor, cantidad_items, usuario_id, usuario_nombre)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [hashArchivo, req.file.originalname || null, proveedor || null, itemsDetectados.length, usuario?.id || null, usuario?.nombre || null]
    );

    // Guardamos lo pendiente de revisar en sesión para la pantalla de confirmación
    req.session.facturaPendiente = { proveedor, facturaReferencia, items: pendientes, esAyb };

    let avisoDuplicada = null;
    if (yaProcesada) {
      const fecha = new Date(yaProcesada.procesado_en).toLocaleString('es-AR');
      avisoDuplicada = `Esta imagen ya se había procesado antes (${fecha}${yaProcesada.usuario_nombre ? ' por ' + yaProcesada.usuario_nombre : ''}). Por las dudas, ningún precio se aplicó solo esta vez — revisá cada ítem antes de confirmar para no duplicar el aumento.`;
    }
    req.session.avisoFacturaDuplicada = avisoDuplicada;

    const volver = esAyb ? '/costos?depto=ayb' : '/costos';

    if (pendientes.length === 0) {
      let mensaje = autoAplicados > 0
        ? `${autoAplicados} precio(s) actualizados automáticamente desde la factura (coincidencia de alta confianza).`
        : 'No hubo cambios de precio para aplicar (los precios detectados no eran mayores a los actuales).';
      return res.redirect(volver + (volver.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(mensaje));
    }

    res.redirect('/costos/factura/revisar' + (autoAplicados > 0 ? ('?autoAplicados=' + autoAplicados) : ''));
  } catch (e) {
    console.error('Error analizando factura con Gemini:', e.message, e.cause || '');
    const esAyb = departamentoEfectivo(req) === 'ayb';
    const volver = esAyb ? '/costos?depto=ayb' : '/costos';
    res.redirect(volver + (volver.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(mensajeErrorGemini(e)));
  }
});

// 2) Muestra la pantalla de confirmación con lo que Gemini detectó y no se auto-aplicó
router.get('/factura/revisar', loginRequerido, async (req, res) => {
  const pendiente = req.session.facturaPendiente || { items: [] };
  const comparacion = pendiente.items || [];
  const autoAplicados = parseInt(req.query.autoAplicados) || 0;
  const avisoDuplicada = req.session.avisoFacturaDuplicada || null;
  res.render('factura_revisar', { comparacion, autoAplicados, avisoDuplicada, umbralAuto: Math.round(UMBRAL_AUTO_APLICAR * 100) });
});

// 3) Aplica los cambios que el usuario tildó y confirmó a mano
router.post('/factura/aplicar', loginRequerido, async (req, res) => {
  const pendiente = req.session.facturaPendiente || { items: [] };
  const comparacion = pendiente.items || [];
  const esAyb = !!pendiente.esAyb;
  const volver = esAyb ? '/costos?depto=ayb' : '/costos';
  let seleccionados = req.body.aplicar || [];
  if (!Array.isArray(seleccionados)) seleccionados = [seleccionados];
  const idxsSeleccionados = seleccionados.map(s => parseInt(s));

  try {
    let aplicados = 0;
    let menoresIgnorados = 0;
    const usuario = req.session.usuario;

    for (const idx of idxsSeleccionados) {
      const item = comparacion.find(c => c.idx === idx);
      if (!item || !item.insumo_id) continue; // sin match a insumo existente, no tocamos nada
      if (!(parseFloat(item.precio_detectado) > 0)) continue; // nunca aplicar precio en 0 o negativo

      const precioActual = parseFloat(item.precio_actual) || 0;
      const precioDetectado = parseFloat(item.precio_detectado);

      // Regla: el precio de costo nunca baja solo — se mantiene el más alto conocido.
      if (precioDetectado < precioActual) {
        menoresIgnorados++;
        continue;
      }

      if (Math.abs(precioDetectado - precioActual) > 0.001) {
        await aplicarCambioPrecio({
          insumoId: item.insumo_id, precioAnterior: precioActual, precioNuevo: precioDetectado,
          proveedor: pendiente.proveedor, facturaReferencia: pendiente.facturaReferencia,
          usuario, confianza: item.confianza != null ? item.confianza / 100 : null, automatico: false, esAyb
        });
      }
      aplicados++;
    }

    delete req.session.facturaPendiente;
    delete req.session.avisoFacturaDuplicada;
    let mensaje = `${aplicados} precio(s) actualizados desde factura.`;
    if (menoresIgnorados > 0) {
      mensaje += ` ${menoresIgnorados} se ignoraron por tener un precio menor al actual (se mantiene el más alto).`;
    }
    res.redirect(volver + (volver.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(mensaje));
  } catch (e) {
    console.error('Error aplicando precios de factura:', e.message);
    res.redirect(volver + (volver.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent('Error aplicando los cambios: ' + e.message));
  }
});

// ── Importación masiva de insumos desde CSV del sistema de compras ────
router.post('/insumos/importar', loginRequerido, uploadCsv.single('archivo_csv'), async (req, res) => {
  const esAyb = departamentoEfectivo(req) === 'ayb';
  const volver = esAyb ? '/costos?depto=ayb' : '/costos';
  if (!req.file) return res.redirect(volver + (volver.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent('No se recibió ningún archivo.'));

  const categoria = (req.body.categoria || '').trim();
  if (!categoria) return res.redirect(volver + (volver.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent('Falta indicar la categoría para este archivo.'));

  try {
    const productos = parsearCsvInsumos(req.file.path);

    if (productos.length === 0) {
      return res.redirect(volver + (volver.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent('El archivo no tiene ningún producto válido (sin código).'));
    }

    if (esAyb) {
      const resumen = await importarProductosAyb(productos, categoria);
      req.session.importacionResumen = { ...resumen, categoria, totalProcesados: productos.length, esAyb: true };
    } else {
      const resumen = await importarInsumos(productos, categoria);

      // Recalculamos en cascada los platos que usan los insumos cuyo precio cambió
      for (const cambio of resumen.cambiosDePrecios) {
        await recalcularPlatos(cambio.insumo_id);
      }

      req.session.importacionResumen = { ...resumen, categoria, totalProcesados: productos.length };
    }
    res.redirect('/costos/insumos/importar/resultado');
  } catch (e) {
    console.error('Error importando insumos:', e.message);
    res.redirect(volver + (volver.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent('Error importando el archivo: ' + e.message));
  }
});

router.get('/insumos/importar/resultado', loginRequerido, async (req, res) => {
  const resumen = req.session.importacionResumen || null;
  res.render('importar_resultado', { resumen });
});

// ── Importación masiva de platos con sus insumos (CSV de costeo tipo "un bloque por plato") ──
router.post('/platos/importar', loginRequerido, uploadCsv.single('archivo_platos'), async (req, res) => {
  if (departamentoEfectivo(req) === 'ayb') return res.redirect('/costos?depto=ayb');
  if (!req.file) return res.redirect('/costos?msg=' + encodeURIComponent('No se recibió ningún archivo.'));

  const categoria = (req.body.categoria_platos || '').trim();
  if (!categoria) return res.redirect('/costos?msg=' + encodeURIComponent('Falta indicar la categoría para estos platos.'));

  try {
    const platos = parsearCsvPlatos(req.file.path);

    if (platos.length === 0) {
      return res.redirect('/costos?msg=' + encodeURIComponent('No se encontró ningún plato con ingredientes en el archivo.'));
    }

    const resumen = await importarPlatos(platos, categoria);
    req.session.importacionPlatosResumen = { ...resumen, categoria, totalPlatos: platos.length };
    res.redirect('/costos/platos/importar/resultado');
  } catch (e) {
    console.error('Error importando platos:', e.message);
    res.redirect('/costos?msg=' + encodeURIComponent('Error importando los platos: ' + e.message));
  }
});

router.get('/platos/importar/resultado', loginRequerido, async (req, res) => {
  const resumen = req.session.importacionPlatosResumen || null;
  res.render('importar_platos_resultado', { resumen });
});

// Suma las líneas de AMBAS tablas (plato_insumos de Cocina y
// plato_insumos_ayb de AYB) — un plato/trago dado solo tiene filas en una
// de las dos, así que sumar las dos sin preguntar el departamento da el
// mismo resultado que ramificar, con menos código.
async function recalcularCostoPlato(plato_id) {
  const items = await db.all2("SELECT costo_parcial FROM plato_insumos WHERE plato_id=$1", [plato_id]);
  const itemsAyb = await db.all2("SELECT costo_parcial FROM plato_insumos_ayb WHERE plato_id=$1", [plato_id]);
  const total = [...items, ...itemsAyb].reduce((s,i) => s+(i.costo_parcial||0), 0);
  await db.run2("UPDATE platos_costo SET costo_total=$1 WHERE id=$2", [total, plato_id]);
}

// Antes esta función traía TODOS los platos que usan el insumo y, PARA
// CADA UNO, hacía una consulta a la base y una actualización aparte, en un
// ciclo secuencial (a veces varias consultas más por plato, vía
// recalcularCostoPlato). Con una importación de CSV que cambia el precio
// de muchos insumos a la vez (el caso real de uso: ver /insumos/importar
// más abajo), esto disparaba cientos de consultas una atrás de la otra.
// Mismo resultado final, pero ahora en 3 consultas en total sin importar
// cuántos platos usen el insumo: una actualiza de una sola vez el
// costo_parcial de TODAS las líneas que usan este insumo (mismo cálculo de
// siempre, cantidad × precio_unitario), y la otra recalcula el
// costo_total de todos los platos afectados de una sola vez, sumando sus
// líneas de ambas tablas (igual que hacía recalcularCostoPlato, pero para
// todos a la vez en vez de uno por uno).
async function recalcularPlatos(insumo_id) {
  const platos = await db.all2("SELECT DISTINCT plato_id FROM plato_insumos WHERE insumo_id=$1", [insumo_id]);
  if (platos.length === 0) return;
  const platoIds = platos.map(p => p.plato_id);
  await db.run2(
    `UPDATE plato_insumos SET costo_parcial = cantidad * (SELECT precio_unitario FROM insumos WHERE id=$1) WHERE insumo_id=$1`,
    [insumo_id]
  );
  await db.run2(
    `UPDATE platos_costo SET costo_total =
       COALESCE((SELECT SUM(costo_parcial) FROM plato_insumos WHERE plato_insumos.plato_id = platos_costo.id), 0) +
       COALESCE((SELECT SUM(costo_parcial) FROM plato_insumos_ayb WHERE plato_insumos_ayb.plato_id = platos_costo.id), 0)
     WHERE id = ANY($1)`,
    [platoIds]
  );
}

// Igual que recalcularPlatos, pero para la cascada de AYB: cuando cambia el
// precio de un producto de productos_ayb, hay que recalcular todos los
// tragos que lo usan como ingrediente (plato_insumos_ayb). Misma
// optimización que arriba, mismo motivo.
async function recalcularPlatosAyb(producto_id) {
  const platos = await db.all2("SELECT DISTINCT plato_id FROM plato_insumos_ayb WHERE insumo_id=$1", [producto_id]);
  if (platos.length === 0) return;
  const platoIds = platos.map(p => p.plato_id);
  await db.run2(
    `UPDATE plato_insumos_ayb SET costo_parcial = cantidad * (SELECT precio_unitario FROM productos_ayb WHERE id=$1) WHERE insumo_id=$1`,
    [producto_id]
  );
  await db.run2(
    `UPDATE platos_costo SET costo_total =
       COALESCE((SELECT SUM(costo_parcial) FROM plato_insumos WHERE plato_insumos.plato_id = platos_costo.id), 0) +
       COALESCE((SELECT SUM(costo_parcial) FROM plato_insumos_ayb WHERE plato_insumos_ayb.plato_id = platos_costo.id), 0)
     WHERE id = ANY($1)`,
    [platoIds]
  );
}

// Se exporta además del router mismo (sin cambiar cómo se usa en server.js)
// para que el asistente/bot pueda reutilizar la misma lógica de variación de
// precios que ya usa esta pantalla, en vez de duplicarla.
module.exports = router;
module.exports.calcularVariacionPrecios = calcularVariacionPrecios;
module.exports.recalcularPlatosAyb = recalcularPlatosAyb;
