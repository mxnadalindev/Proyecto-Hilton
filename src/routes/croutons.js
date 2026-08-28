const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido, requiereDepartamento } = require('./middleware');
const multer = require('multer');
const path = require('path');
const ExcelJS = require('exceljs');
router.use(loginRequerido, requiereDepartamento('/croutons'));
// Croutons (vencimientos de mercadería) es solo para quien gestiona AYB
// (admin/supervisor) — un mozo común solo debe poder entrar a Horarios,
// nada más de A&B (mismo criterio que "Miembro de equipo" en personal.js).
router.use((req, res, next) => {
  const departamento = (req.session.usuario.departamento || '').toLowerCase();
  const rol = (req.session.usuario.rol || '').toLowerCase();
  if (departamento === 'ayb' && rol !== 'admin' && rol !== 'supervisor') {
    return res.redirect('/horarios');
  }
  next();
});
const { analizarRemitoCroutons, mensajeErrorGemini } = require('../services/gemini');
const { parsearCsvCroutons, importarLotesCroutons } = require('../services/importadorCroutons');

const storageRemito = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, 'remito_croutons_' + Date.now() + path.extname(file.originalname))
});
const uploadRemito = multer({ storage: storageRemito, limits: { fileSize: 10 * 1024 * 1024 } });

const storageCsv = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, 'croutons_' + Date.now() + path.extname(file.originalname))
});
const uploadCsv = multer({ storage: storageCsv, limits: { fileSize: 30 * 1024 * 1024 } });

// Días de anticipación para la alerta de vencimiento próximo
const DIAS_ALERTA = 15;
// Días que se conserva un lote consumido antes de borrarse solo
const DIAS_RETENCION_CONSUMIDOS = 15;

// Agrupa los lotes activos por nombre de producto — cada grupo suma sus
// lotes y se queda con la fecha de vencimiento más próxima de todos ellos.
// "minimosPorProducto" y "categoriasPorProducto" son Maps (clave = nombre
// en minúsculas) con lo que haya configurado en el catálogo productos_ayb.
function agruparPorProducto(lotes, minimosPorProducto, categoriasPorProducto) {
  const mapa = new Map();
  for (const l of lotes) {
    const clave = l.producto.trim().toLowerCase();
    if (!mapa.has(clave)) {
      mapa.set(clave, { producto: l.producto, lotes: [], pesoTotalKg: 0 });
    }
    const grupo = mapa.get(clave);
    grupo.lotes.push(l);
    if (l.peso && (l.unidad_peso || 'kg') === 'kg') grupo.pesoTotalKg += parseFloat(l.peso);
  }
  const productos = [...mapa.values()].map(g => {
    const diasMin = Math.min(...g.lotes.map(l => l.dias_para_vencer));
    const loteMasProximo = g.lotes.find(l => l.dias_para_vencer === diasMin);

    const clave = g.producto.trim().toLowerCase();
    const stockActual = g.lotes.reduce((suma, l) => suma + (parseFloat(l.cantidad) || 0), 0);
    const stockMinimo = minimosPorProducto.has(clave) ? minimosPorProducto.get(clave) : null;
    const stockBajo = stockMinimo !== null && stockActual <= stockMinimo;
    const categoria = categoriasPorProducto.get(clave) || 'General';

    return {
      ...g,
      totalLotes: g.lotes.length,
      diasParaVencerMinimo: diasMin,
      fechaVencimientoMasProxima: loteMasProximo.fecha_vencimiento,
      stockActual,
      stockMinimo,
      stockBajo,
      categoria,
    };
  });
  productos.sort((a, b) => a.diasParaVencerMinimo - b.diasParaVencerMinimo);
  return productos;
}

// Agrupa un listado de productos (ya armado por agruparPorProducto) en
// categorías, para mostrarlas como barras desplegables en el panel
// izquierdo. Ordena las categorías alfabéticamente, dejando "General" al
// final (es la que le toca a lo que nadie categorizó todavía).
function agruparPorCategoria(productos) {
  const mapa = new Map();
  for (const p of productos) {
    if (!mapa.has(p.categoria)) mapa.set(p.categoria, []);
    mapa.get(p.categoria).push(p);
  }
  const categorias = [...mapa.entries()].map(([categoria, lista]) => ({ categoria, productos: lista }));
  categorias.sort((a, b) => {
    if (a.categoria === 'General') return 1;
    if (b.categoria === 'General') return -1;
    return a.categoria.localeCompare(b.categoria, 'es');
  });
  return categorias;
}

// Sincroniza el catálogo (productos_ayb) con lo que ya se completó al
// cargar o editar un lote — así no hay que volver a escribir la unidad, el
// código de barras o la categoría en el catálogo por separado, se toma de
// acá. No pisa el código de barras ni la categoría existentes si esta vez
// se dejaron vacíos (por ejemplo, al editar sin volver a elegir categoría).
async function sincronizarCatalogoDesdeLote(producto, unidad, codigoBarras, categoria) {
  try {
    const existente = await db.get2(
      `SELECT id FROM productos_ayb WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
      [producto]
    );

    if (existente) {
      const campos = ['unidad_default = $1'];
      const valores = [unidad];
      let idx = 2;
      if (codigoBarras) { campos.push(`codigo_barras = $${idx}`); valores.push(codigoBarras); idx++; }
      if (categoria) { campos.push(`categoria = $${idx}`); valores.push(categoria); idx++; }
      valores.push(existente.id);
      await db.run2(`UPDATE productos_ayb SET ${campos.join(', ')} WHERE id = $${idx}`, valores);
    } else {
      await db.run2(
        `INSERT INTO productos_ayb (nombre, unidad_default, codigo_barras, categoria) VALUES ($1, $2, $3, $4)`,
        [producto, unidad, codigoBarras || null, categoria || 'General']
      );
    }
  } catch (e) {
    // Si el código de barras ya está usado por otro producto, no rompemos
    // el guardado del lote por eso — solo lo dejamos en el log.
    console.error('(!) No se pudo sincronizar el catálogo desde el lote:', e.message);
  }
}

// ── Listado principal ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  const lotes = await db.all2(`
    SELECT *, (fecha_vencimiento - CURRENT_DATE) AS dias_para_vencer
    FROM croutons_lotes
    WHERE estado = 'activo'
    ORDER BY fecha_vencimiento ASC, producto ASC
  `);

  const vencidos = lotes.filter(l => l.dias_para_vencer < 0);
  const porVencer = lotes.filter(l => l.dias_para_vencer >= 0 && l.dias_para_vencer <= DIAS_ALERTA);

  // Mínimos y categorías configurados en el catálogo — solo los productos
  // con stock_minimo cargado participan de la alerta de reposición; la
  // categoría se usa para agrupar el panel de productos en barras.
  const filasCatalogo = await db.all2(
    `SELECT id, nombre, stock_minimo, categoria, unidad_default, codigo_barras FROM productos_ayb ORDER BY categoria ASC, nombre ASC`
  );
  const minimosPorProducto = new Map();
  const categoriasPorProducto = new Map();
  for (const f of filasCatalogo) {
    const clave = f.nombre.trim().toLowerCase();
    if (f.stock_minimo !== null) minimosPorProducto.set(clave, parseFloat(f.stock_minimo));
    if (f.categoria) categoriasPorProducto.set(clave, f.categoria);
  }

  let productos = agruparPorProducto(lotes, minimosPorProducto, categoriasPorProducto);
  const productosStockBajo = productos.filter(p => p.stockBajo);

  // Filtro opcional por tarjeta (?tipo=vencidos | porvencer | stockbajo)
  const tipoFiltro = ['vencidos', 'porvencer', 'stockbajo'].includes(req.query.tipo) ? req.query.tipo : null;
  if (tipoFiltro === 'vencidos') {
    productos = productos.filter(p => p.lotes.some(l => l.dias_para_vencer < 0));
  } else if (tipoFiltro === 'porvencer') {
    productos = productos.filter(p => p.lotes.some(l => l.dias_para_vencer >= 0 && l.dias_para_vencer <= DIAS_ALERTA));
  } else if (tipoFiltro === 'stockbajo') {
    productos = productos.filter(p => p.stockBajo);
  }

  const categorias = agruparPorCategoria(productos);
  const categoriasDisponibles = [...new Set(
    filasCatalogo.map(f => f.categoria).filter(c => c && c !== 'General')
  )].sort((a, b) => a.localeCompare(b, 'es'));

  const totalConsumidos = await db.get2("SELECT COUNT(*)::int AS c FROM croutons_lotes WHERE estado='consumido'");

  const msg = req.query.msg || null;
  const geminiConfigurado = !!process.env.GEMINI_API_KEY;

  res.render('croutons', {
    lotes,
    productos,
    categorias,
    categoriasDisponibles,
    catalogo: filasCatalogo,
    vencidos,
    porVencer,
    productosStockBajo,
    totalLotes: lotes.length,
    totalProductos: agruparPorProducto(lotes, minimosPorProducto, categoriasPorProducto).length, // sin filtrar, para la tarjeta de arriba
    totalConsumidos: totalConsumidos?.c || 0,
    tipoFiltro,
    diasAlerta: DIAS_ALERTA,
    msg,
    geminiConfigurado,
  });
});

// ── Catálogo de productos (para el lector de código de barras) ────
router.get('/productos/buscar', async (req, res) => {
  const codigo = (req.query.codigo || '').trim();
  if (!codigo) return res.json({ encontrado: false });
  try {
    const producto = await db.get2('SELECT * FROM productos_ayb WHERE codigo_barras = $1', [codigo]);
    if (producto) return res.json({ encontrado: true, producto });
    res.json({ encontrado: false, codigo });
  } catch (e) {
    console.error('Error buscando producto por código:', e.message);
    res.json({ encontrado: false, error: e.message });
  }
});

// ── Guardar/actualizar la unidad por defecto de un producto ────────
router.post('/producto/unidad', async (req, res) => {
  const producto = (req.body.producto || '').trim();
  const unidad = (req.body.unidad_default || '').trim() || 'unidad';

  if (!producto) return res.json({ ok: false, error: 'Falta el nombre del producto.' });

  try {
    const existente = await db.get2(
      `SELECT id FROM productos_ayb WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
      [producto]
    );

    if (existente) {
      await db.run2(`UPDATE productos_ayb SET unidad_default = $1 WHERE id = $2`, [unidad, existente.id]);
    } else {
      await db.run2(`INSERT INTO productos_ayb (nombre, unidad_default) VALUES ($1, $2)`, [producto, unidad]);
    }

    res.json({ ok: true, unidad });
  } catch (e) {
    console.error('Error guardando unidad por defecto:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── Guardar/actualizar el código de barras de un producto ──────────
router.post('/producto/codigo', async (req, res) => {
  const producto = (req.body.producto || '').trim();
  const codigo = (req.body.codigo_barras || '').trim();

  if (!producto) return res.json({ ok: false, error: 'Falta el nombre del producto.' });

  try {
    const existente = await db.get2(
      `SELECT id FROM productos_ayb WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
      [producto]
    );

    if (existente) {
      await db.run2(`UPDATE productos_ayb SET codigo_barras = $1 WHERE id = $2`, [codigo || null, existente.id]);
    } else {
      await db.run2(`INSERT INTO productos_ayb (nombre, codigo_barras) VALUES ($1, $2)`, [producto, codigo || null]);
    }

    res.json({ ok: true, codigo });
  } catch (e) {
    // codigo_barras tiene un UNIQUE constraint — si ya lo usa otro producto, avisar claro
    if (/duplicate key|unique/i.test(e.message)) {
      return res.json({ ok: false, error: 'Ese código de barras ya está asociado a otro producto.' });
    }
    console.error('Error guardando código de barras:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── Eliminar un producto del catálogo (no afecta lotes ya cargados) ────
router.post('/producto/:id/eliminar', async (req, res) => {
  try {
    await db.run2(`DELETE FROM productos_ayb WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error eliminando producto del catálogo:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── Alta de un producto nuevo en el catálogo (sin cargarle un lote todavía) ──
router.post('/producto/nuevo', async (req, res) => {
  const producto = (req.body.producto || '').trim();
  if (!producto) return res.json({ ok: false, error: 'Falta el nombre del producto.' });

  try {
    const existente = await db.get2(
      `SELECT id FROM productos_ayb WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
      [producto]
    );
    if (existente) return res.json({ ok: false, error: 'Ese producto ya está en el catálogo.' });

    await db.run2(`INSERT INTO productos_ayb (nombre) VALUES ($1)`, [producto]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error agregando producto al catálogo:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── Guardar/actualizar el stock mínimo de un producto (alerta de reposición) ──
// Se matchea por nombre (case-insensitive) contra productos_ayb, no por
// código de barras, porque muchos productos se cargan a mano sin escanear.
// Si no existe todavía una fila en el catálogo para ese nombre, se crea una
// (sin código de barras) solo para poder guardar el mínimo.
router.post('/producto/minimo', async (req, res) => {
  const producto = (req.body.producto || '').trim();
  const stockMinimoRaw = req.body.stock_minimo;

  if (!producto) return res.json({ ok: false, error: 'Falta el nombre del producto.' });

  // Vacío = borrar el mínimo (el producto deja de participar de la alerta)
  const stockMinimo = (stockMinimoRaw === '' || stockMinimoRaw === null || stockMinimoRaw === undefined)
    ? null
    : parseFloat(stockMinimoRaw);

  if (stockMinimo !== null && (isNaN(stockMinimo) || stockMinimo < 0)) {
    return res.json({ ok: false, error: 'El mínimo tiene que ser un número positivo.' });
  }

  try {
    const existente = await db.get2(
      `SELECT id FROM productos_ayb WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
      [producto]
    );

    if (existente) {
      await db.run2(
        `UPDATE productos_ayb SET stock_minimo = $1 WHERE id = $2`,
        [stockMinimo, existente.id]
      );
    } else {
      await db.run2(
        `INSERT INTO productos_ayb (nombre, stock_minimo) VALUES ($1, $2)`,
        [producto, stockMinimo]
      );
    }

    res.json({ ok: true, stockMinimo });
  } catch (e) {
    console.error('Error guardando stock mínimo:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── Guardar/actualizar la categoría de un producto (agrupado del panel) ──
router.post('/producto/categoria', async (req, res) => {
  const producto = (req.body.producto || '').trim();
  const categoria = (req.body.categoria || '').trim() || 'General';

  if (!producto) return res.json({ ok: false, error: 'Falta el nombre del producto.' });

  try {
    const existente = await db.get2(
      `SELECT id FROM productos_ayb WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
      [producto]
    );

    if (existente) {
      await db.run2(`UPDATE productos_ayb SET categoria = $1 WHERE id = $2`, [categoria, existente.id]);
    } else {
      await db.run2(`INSERT INTO productos_ayb (nombre, categoria) VALUES ($1, $2)`, [producto, categoria]);
    }

    res.json({ ok: true, categoria });
  } catch (e) {
    console.error('Error guardando categoría:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── Alta manual de un lote ────────────────────────────────────────
router.post('/lote/nuevo', async (req, res) => {
  const producto = (req.body.producto || '').trim();
  const fechaVencimiento = (req.body.fecha_vencimiento || '').trim();
  const fechaIngreso = (req.body.fecha_ingreso || '').trim();
  const codigoBarras = (req.body.codigo_barras || '').trim();
  const categoria = (req.body.categoria || '').trim();

  if (!producto) return res.redirect('/croutons?msg=' + encodeURIComponent('Falta el nombre del producto.'));
  if (!fechaVencimiento) return res.redirect('/croutons?msg=' + encodeURIComponent('Falta la fecha de vencimiento.'));

  try {
    await db.run2(
      `INSERT INTO croutons_lotes (producto, cantidad, unidad, proveedor, lote_proveedor, fecha_ingreso, fecha_vencimiento, notas, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        producto,
        parseFloat(req.body.cantidad) || 0,
        (req.body.unidad || 'kg').trim(),
        (req.body.proveedor || '').trim(),
        (req.body.lote_proveedor || '').trim(),
        fechaIngreso || new Date().toISOString().split('T')[0],
        fechaVencimiento,
        (req.body.notas || '').trim(),
        req.session.usuario.id,
      ]
    );

    await sincronizarCatalogoDesdeLote(producto, (req.body.unidad || 'unidad').trim(), codigoBarras, categoria);

    res.redirect('/croutons?msg=' + encodeURIComponent('Lote agregado.'));
  } catch (e) {
    console.error('Error agregando lote de croutons:', e.message);
    res.redirect('/croutons?msg=' + encodeURIComponent('Error agregando el lote: ' + e.message));
  }
});

// ── Editar un lote existente (corregir un dato mal cargado) ───────
router.post('/lote/:id/editar', async (req, res) => {
  const producto = (req.body.producto || '').trim();
  const fechaVencimiento = (req.body.fecha_vencimiento || '').trim();
  const codigoBarras = (req.body.codigo_barras || '').trim();
  const categoria = (req.body.categoria || '').trim();

  if (!producto) return res.redirect('/croutons?msg=' + encodeURIComponent('Falta el nombre del producto.'));
  if (!fechaVencimiento) return res.redirect('/croutons?msg=' + encodeURIComponent('Falta la fecha de vencimiento.'));

  try {
    await db.run2(
      `UPDATE croutons_lotes SET
         producto=$1, cantidad=$2, unidad=$3, peso=$4, unidad_peso=$5,
         proveedor=$6, lote_proveedor=$7, fecha_ingreso=$8, fecha_vencimiento=$9,
         notas=$10, actualizado_en=NOW()
       WHERE id=$11`,
      [
        producto,
        parseFloat(req.body.cantidad) || 0,
        (req.body.unidad || 'unidad').trim(),
        req.body.peso ? parseFloat(req.body.peso) : null,
        (req.body.unidad_peso || 'kg').trim(),
        (req.body.proveedor || '').trim(),
        (req.body.lote_proveedor || '').trim(),
        (req.body.fecha_ingreso || '').trim() || new Date().toISOString().split('T')[0],
        fechaVencimiento,
        (req.body.notas || '').trim(),
        req.params.id,
      ]
    );

    await sincronizarCatalogoDesdeLote(producto, (req.body.unidad || 'unidad').trim(), codigoBarras, categoria);

    res.redirect('/croutons?msg=' + encodeURIComponent('Lote actualizado.'));
  } catch (e) {
    console.error('Error editando lote de croutons:', e.message);
    res.redirect('/croutons?msg=' + encodeURIComponent('Error editando el lote: ' + e.message));
  }
});

// ── Ajustar cantidad restante de un lote (se mantiene por compatibilidad) ──
router.post('/lote/:id/cantidad', async (req, res) => {
  try {
    await db.run2(
      `UPDATE croutons_lotes SET cantidad=$1, actualizado_en=NOW() WHERE id=$2`,
      [parseFloat(req.body.cantidad) || 0, req.params.id]
    );
    res.redirect('/croutons?msg=' + encodeURIComponent('Cantidad actualizada.'));
  } catch (e) {
    res.redirect('/croutons?msg=' + encodeURIComponent('Error actualizando la cantidad: ' + e.message));
  }
});

// ── Marcar un lote como consumido (sale de la lista sin borrar el historial) ──
router.post('/lote/:id/consumir', async (req, res) => {
  try {
    await db.run2(
      `UPDATE croutons_lotes SET estado='consumido', consumido_en=NOW(), actualizado_en=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.redirect('/croutons?msg=' + encodeURIComponent('Lote marcado como consumido.'));
  } catch (e) {
    res.redirect('/croutons?msg=' + encodeURIComponent('Error: ' + e.message));
  }
});

// ── Eliminar un lote (carga por error, etc.) ──────────────────────
router.post('/lote/:id/eliminar', async (req, res) => {
  try {
    await db.run2(`DELETE FROM croutons_lotes WHERE id=$1`, [req.params.id]);
    res.redirect('/croutons?msg=' + encodeURIComponent('Lote eliminado.'));
  } catch (e) {
    res.redirect('/croutons?msg=' + encodeURIComponent('Error eliminando el lote: ' + e.message));
  }
});

// ── Consumidos: listado (JSON, para el panel) ──────────────────────
router.get('/consumidos', async (req, res) => {
  try {
    const filas = await db.all2(`
      SELECT *,
        EXTRACT(DAY FROM NOW() - consumido_en)::int AS dias_transcurridos
      FROM croutons_lotes
      WHERE estado = 'consumido'
      ORDER BY consumido_en DESC
    `);
    const consumidos = filas.map(f => ({
      ...f,
      dias_restantes: Math.max(0, DIAS_RETENCION_CONSUMIDOS - (f.dias_transcurridos || 0)),
    }));
    res.json({ ok: true, consumidos });
  } catch (e) {
    console.error('Error listando consumidos:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── Restaurar un lote consumido (deshacer) ─────────────────────────
router.post('/lote/:id/restaurar', async (req, res) => {
  try {
    await db.run2(
      `UPDATE croutons_lotes SET estado='activo', consumido_en=NULL, actualizado_en=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Error restaurando lote:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── Descargar Excel con el listado activo ──────────────────────────
router.get('/excel', async (req, res) => {
  const lotes = await db.all2(`
    SELECT *, (fecha_vencimiento - CURRENT_DATE) AS dias_para_vencer
    FROM croutons_lotes
    WHERE estado = 'activo'
    ORDER BY fecha_vencimiento ASC, producto ASC
  `);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Croutons');

  ws.mergeCells('A1:J1');
  const titulo = ws.getCell('A1');
  titulo.value = `CROUTONS / A&B — LOTES ACTIVOS — ${new Date().toLocaleDateString('es-AR')}`;
  titulo.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  titulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  titulo.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  const encRow = ws.addRow(['Producto', 'Cantidad', 'Empaque', 'Peso', 'Unidad', 'Proveedor', 'Lote prov.', 'Ingreso', 'Vencimiento', 'Estado']);
  encRow.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  const colores = { vencido: 'FFDC2626', porvencer: 'FF92400E', ok: 'FF16A34A' };

  lotes.forEach(l => {
    const dias = l.dias_para_vencer;
    let estadoTexto, tipoColor;
    if (dias < 0) { estadoTexto = `Vencido hace ${Math.abs(dias)}d`; tipoColor = 'vencido'; }
    else if (dias <= DIAS_ALERTA) { estadoTexto = `Vence en ${dias}d`; tipoColor = 'porvencer'; }
    else { estadoTexto = `Vence en ${dias}d`; tipoColor = 'ok'; }

    const row = ws.addRow([
      l.producto, parseFloat(l.cantidad) || 0, l.unidad,
      l.peso ? parseFloat(l.peso) : '', l.unidad_peso || '',
      l.proveedor || '', l.lote_proveedor || '',
      new Date(l.fecha_ingreso).toLocaleDateString('es-AR'),
      new Date(l.fecha_vencimiento).toLocaleDateString('es-AR'),
      estadoTexto,
    ]);
    row.eachCell((c, col) => {
      c.font = { size: 10 };
      c.alignment = { horizontal: col === 1 ? 'left' : 'center', vertical: 'middle' };
      if (col === 10) { c.font = { size: 10, bold: true, color: { argb: colores[tipoColor] } }; }
    });
  });

  ws.columns = [{ width: 26 }, { width: 10 }, { width: 12 }, { width: 9 }, { width: 8 }, { width: 20 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 16 }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=croutons_${new Date().toISOString().split('T')[0]}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

// ── 1) Foto de remito/etiqueta de mercadería -> Gemini ────────────
router.post('/remito', uploadRemito.single('remito'), async (req, res) => {
  if (!req.file) return res.redirect('/croutons?msg=' + encodeURIComponent('No se recibió ninguna imagen.'));

  try {
    const { tipoDocumento, items } = await analizarRemitoCroutons(req.file.path);

    if (tipoDocumento === 'otro') {
      return res.redirect('/croutons?msg=' + encodeURIComponent(
        'No se reconoció la imagen como un remito o etiqueta de mercadería.'
      ));
    }
    if (items.length === 0) {
      return res.redirect('/croutons?msg=' + encodeURIComponent(
        'No se pudo leer ningún producto con fecha de vencimiento en la imagen. Probá con otra foto o cargalo a mano.'
      ));
    }

    req.session.croutonsRemitoPendiente = items;
    res.redirect('/croutons/remito/revisar');
  } catch (e) {
    console.error('Error analizando remito de croutons con Gemini:', e.message, e.cause || '');
    res.redirect('/croutons?msg=' + encodeURIComponent(mensajeErrorGemini(e)));
  }
});

// ── 2) Pantalla de confirmación con lo que Gemini detectó ─────────
router.get('/remito/revisar', async (req, res) => {
  const items = req.session.croutonsRemitoPendiente || [];
  res.render('croutons_remito_revisar', { items });
});

// ── 3) Aplica los lotes tildados (con los valores ya editados a mano) ──
router.post('/remito/aplicar', async (req, res) => {
  const items = req.session.croutonsRemitoPendiente || [];
  let seleccionados = req.body.aplicar || [];
  if (!Array.isArray(seleccionados)) seleccionados = [seleccionados];
  const idxsSeleccionados = seleccionados.map(s => parseInt(s));

  const productos = req.body.producto || {};
  const cantidades = req.body.cantidad || {};
  const unidades = req.body.unidad || {};
  const proveedores = req.body.proveedor || {};
  const vencimientos = req.body.fecha_vencimiento || {};

  let cargados = 0;
  let omitidos = 0;

  try {
    for (const idx of idxsSeleccionados) {
      if (!items[idx]) continue;

      const producto = (productos[idx] || '').trim();
      const fechaVencimiento = (vencimientos[idx] || '').trim();

      if (!producto || !fechaVencimiento) {
        omitidos++;
        continue;
      }

      await db.run2(
        `INSERT INTO croutons_lotes (producto, cantidad, unidad, proveedor, fecha_vencimiento, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          producto,
          parseFloat(cantidades[idx]) || 0,
          (unidades[idx] || 'kg').trim(),
          (proveedores[idx] || '').trim(),
          fechaVencimiento,
          req.session.usuario.id,
        ]
      );
      cargados++;
    }

    delete req.session.croutonsRemitoPendiente;

    let mensaje = `${cargados} lote(s) cargados desde la imagen.`;
    if (omitidos > 0) mensaje += ` ${omitidos} se omitieron por falta de producto o fecha de vencimiento.`;
    res.redirect('/croutons?msg=' + encodeURIComponent(mensaje));
  } catch (e) {
    console.error('Error aplicando remito de croutons:', e.message);
    res.redirect('/croutons?msg=' + encodeURIComponent('Error cargando los lotes: ' + e.message));
  }
});

// ── Importación masiva desde CSV/catálogo del proveedor ───────────
router.post('/importar', uploadCsv.single('archivo_croutons'), async (req, res) => {
  if (!req.file) return res.redirect('/croutons?msg=' + encodeURIComponent('No se recibió ningún archivo.'));

  try {
    const productos = parsearCsvCroutons(req.file.path);

    if (productos.length === 0) {
      return res.redirect('/croutons?msg=' + encodeURIComponent('El archivo no tiene ninguna fila con datos.'));
    }

    const proveedorPorDefecto = (req.body.proveedor_csv || '').trim();
    const resumen = await importarLotesCroutons(productos, proveedorPorDefecto, req.session.usuario.id);

    req.session.croutonsImportacionResumen = { ...resumen, totalProcesados: productos.length };
    res.redirect('/croutons/importar/resultado');
  } catch (e) {
    console.error('Error importando croutons:', e.message);
    res.redirect('/croutons?msg=' + encodeURIComponent('Error importando el archivo: ' + e.message));
  }
});

router.get('/importar/resultado', async (req, res) => {
  const resumen = req.session.croutonsImportacionResumen || null;
  res.render('croutons_importar_resultado', { resumen });
});

module.exports = router;
