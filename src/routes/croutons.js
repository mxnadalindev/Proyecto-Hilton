const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido, requiereDepartamento } = require('./middleware');
const multer = require('multer');
const path = require('path');
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

  const msg = req.query.msg || null;
  const geminiConfigurado = !!process.env.GEMINI_API_KEY;

  res.render('croutons', {
    lotes,
    vencidos,
    porVencer,
    totalLotes: lotes.length,
    diasAlerta: DIAS_ALERTA,
    msg,
    geminiConfigurado,
  });
});

// ── Alta manual de un lote ────────────────────────────────────────
router.post('/lote/nuevo', async (req, res) => {
  const producto = (req.body.producto || '').trim();
  const fechaVencimiento = (req.body.fecha_vencimiento || '').trim();

  if (!producto) return res.redirect('/croutons?msg=' + encodeURIComponent('Falta el nombre del producto.'));
  if (!fechaVencimiento) return res.redirect('/croutons?msg=' + encodeURIComponent('Falta la fecha de vencimiento.'));

  try {
    await db.run2(
      `INSERT INTO croutons_lotes (producto, cantidad, unidad, proveedor, lote_proveedor, fecha_vencimiento, notas, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        producto,
        parseFloat(req.body.cantidad) || 0,
        (req.body.unidad || 'kg').trim(),
        (req.body.proveedor || '').trim(),
        (req.body.lote_proveedor || '').trim(),
        fechaVencimiento,
        (req.body.notas || '').trim(),
        req.session.usuario.id,
      ]
    );
    res.redirect('/croutons?msg=' + encodeURIComponent('Lote de croutons agregado.'));
  } catch (e) {
    console.error('Error agregando lote de croutons:', e.message);
    res.redirect('/croutons?msg=' + encodeURIComponent('Error agregando el lote: ' + e.message));
  }
});

// ── Ajustar cantidad restante de un lote ──────────────────────────
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
      `UPDATE croutons_lotes SET estado='consumido', actualizado_en=NOW() WHERE id=$1`,
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
