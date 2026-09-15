// src/routes/desayuno.js — Módulo Desayuno (AYB).
//
// Reemplaza el chequeo manual, habitación por habitación, de un reporte de
// 15 páginas ("Breakfast Package" del sistema de reservas): se sube el
// reporte del día (Excel/CSV o PDF) y después la hostess solo escribe el
// número de habitación para ver toda la info de una: si tiene el desayuno
// incluido, si es tripulación (y de qué aerolínea), si es socio HH, y si
// tiene algún pedido especial (como "TR").
//
// Igual patrón que /personal/importar-mozos-foto: lo que se lee del
// archivo queda pendiente en la sesión para revisar en pantalla ANTES de
// aplicarlo — nunca se pisa la base directo desde el archivo subido.
const express = require('express');
const router = express.Router();
const db = require('../db/database');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { loginRequerido, requiereDepartamento } = require('./middleware');
const { analizarReporteDesayuno, mensajeErrorGemini } = require('../services/gemini');
const { parsearArchivoDesayuno } = require('../services/importadorDesayuno');
const { parsearPdfDesayuno } = require('../services/parserPdfDesayuno');

router.use(loginRequerido, requiereDepartamento('/desayuno'));

const storageReporte = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, 'desayuno_' + Date.now() + path.extname(file.originalname))
});
const uploadReporte = multer({ storage: storageReporte, limits: { fileSize: 20 * 1024 * 1024 } });

// Aerolíneas cuya tripulación identificamos por el "Group Name" — y la
// regla de negocio que Maxi confirmó: Delta/United/Lufthansa NO tienen el
// desayuno incluido, Air France/Iberia SÍ. Esto se muestra en pantalla como
// dato adicional (no pisa lo que diga Ttl Pkg. Amt., que sigue siendo la
// fuente real de si está pago o no) — así, si alguna vez no coinciden, la
// hostess ve las dos cosas en vez de que el sistema decida por ella.
const AEROLINEAS_TRIPULACION = [
  { match: 'delta', nombre: 'Delta', bkfIncluidoSegunRegla: false },
  { match: 'united', nombre: 'United', bkfIncluidoSegunRegla: false },
  { match: 'lufthansa', nombre: 'Lufthansa', bkfIncluidoSegunRegla: false },
  { match: 'air france', nombre: 'Air France', bkfIncluidoSegunRegla: true },
  { match: 'iberia', nombre: 'Iberia', bkfIncluidoSegunRegla: true },
];

function detectarTripulacion(groupName) {
  const g = (groupName || '').toLowerCase();
  return AEROLINEAS_TRIPULACION.find(a => g.includes(a.match)) || null;
}

// Los códigos de "Membership Level" (B, S, D, L, G en el reporte de
// ejemplo) todavía no están confirmados — se muestran tal cual figuran en
// el reporte en vez de adivinar a qué categoría de Hilton Honors
// corresponden. Cuando Maxi confirme la equivalencia, completar este mapa
// (ej: { B: 'Blue', S: 'Silver', G: 'Gold', D: 'Diamond' }) — el resto del
// código ya está listo para usarlo, ver enriquecerFila() más abajo.
const CODIGOS_MEMBRESIA = {};

function enriquecerFila(fila) {
  const tripulacion = detectarTripulacion(fila.group_name);
  const specialRequestCodigos = (fila.special_request || '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    ...fila,
    bkfIncluido: parseFloat(fila.ttl_pkg_amt) > 0,
    tripulacionDe: tripulacion ? tripulacion.nombre : null,
    tripulacionBkfSegunRegla: tripulacion ? tripulacion.bkfIncluidoSegunRegla : null,
    membershipLabel: fila.membership_level ? (CODIGOS_MEMBRESIA[fila.membership_level] || fila.membership_level) : '',
    tieneTR: specialRequestCodigos.some(c => c.toUpperCase() === 'TR'),
    specialRequestCodigos,
  };
}

// ── Pantalla principal: buscador por habitación + estado del último reporte ──
router.get('/', async (req, res) => {
  const ultimo = await db.get2("SELECT MAX(fecha_reporte)::text AS fecha FROM desayuno_habitaciones");
  const fechaReporte = ultimo?.fecha || null;

  let totalHabitaciones = 0, sinDesayuno = 0, conTR = 0, tripulacion = 0;
  if (fechaReporte) {
    const filas = await db.all2("SELECT group_name, special_request, ttl_pkg_amt FROM desayuno_habitaciones WHERE fecha_reporte=$1", [fechaReporte]);
    totalHabitaciones = filas.length;
    sinDesayuno = filas.filter(f => parseFloat(f.ttl_pkg_amt) <= 0).length;
    conTR = filas.filter(f => (f.special_request || '').split(',').map(s => s.trim().toUpperCase()).includes('TR')).length;
    tripulacion = filas.filter(f => detectarTripulacion(f.group_name)).length;
  }

  res.render('desayuno', {
    fechaReporte,
    totalHabitaciones,
    sinDesayuno,
    conTR,
    tripulacion,
    msg: req.query.msg || null,
  });
});

// ── Buscador en vivo por habitación (mismo patrón que /costos/insumos/buscar-vivo) ──
router.get('/buscar', async (req, res) => {
  const habitacion = (req.query.habitacion || '').trim();
  if (!habitacion) return res.json({ resultados: [] });

  const ultimo = await db.get2("SELECT MAX(fecha_reporte)::text AS fecha FROM desayuno_habitaciones");
  if (!ultimo?.fecha) return res.json({ resultados: [], sinReporte: true });

  const filas = await db.all2(
    `SELECT habitacion, nombre_huesped, membership_level, adultos, ninos, fecha_llegada::text, fecha_salida::text,
            estado_reserva, group_name, company_name, special_request, ttl_pkg_amt
     FROM desayuno_habitaciones WHERE fecha_reporte=$1 AND habitacion ILIKE $2
     ORDER BY habitacion LIMIT 20`,
    [ultimo.fecha, `%${habitacion}%`]
  );

  const resultados = filas.map(f => enriquecerFila({
    ...f,
    fecha_llegada: f.fecha_llegada,
    fecha_salida: f.fecha_salida,
  }));

  res.json({ resultados, fechaReporte: ultimo.fecha });
});

// ── Subir el reporte del día (Excel/CSV o PDF) — queda pendiente para revisar ──
router.post('/importar', uploadReporte.single('archivo'), async (req, res) => {
  if (!req.file) return res.redirect('/desayuno?msg=' + encodeURIComponent('No se subió ningún archivo.'));

  const esPdf = /\.pdf$/i.test(req.file.originalname) || req.file.mimetype === 'application/pdf';

  try {
    let fechaReporte, filas;
    if (esPdf) {
      // Primero se intenta leer el PDF de forma determinística (sin IA,
      // sin límite de cuota) — funciona siempre que sea el "Breakfast
      // Package" real del sistema de reservas, con texto seleccionable
      // (no una foto/escaneo). Si por lo que sea no reconoce ninguna fila
      // (otro formato de reporte, un PDF escaneado, etc.), se recurre a
      // Gemini como respaldo, que entiende cualquier formato pero depende
      // de la cuota diaria gratuita.
      let resultadoTexto = null;
      try {
        resultadoTexto = await parsearPdfDesayuno(req.file.path);
      } catch (errTexto) {
        console.error('Lector de PDF sin IA no pudo leer el archivo, se prueba con Gemini:', errTexto.message);
      }

      if (resultadoTexto && resultadoTexto.filas.length > 0) {
        fechaReporte = resultadoTexto.fechaReporte;
        filas = resultadoTexto.filas;
        fs.unlink(req.file.path, () => {});
      } else {
        const resultado = await analizarReporteDesayuno(req.file.path, req.file.mimetype);
        fs.unlink(req.file.path, () => {});
        if (resultado.tipoDocumento === 'otro') {
          return res.redirect('/desayuno?msg=' + encodeURIComponent('No se reconoció el archivo como el reporte de desayuno.'));
        }
        fechaReporte = resultado.fechaReporte;
        filas = resultado.filas;
      }
    } else {
      const resultado = await parsearArchivoDesayuno(req.file.path, req.file.originalname);
      fs.unlink(req.file.path, () => {});
      fechaReporte = resultado.fechaReporte;
      filas = resultado.filas;
    }

    if (filas.length === 0) {
      return res.redirect('/desayuno?msg=' + encodeURIComponent('No se pudo leer ninguna habitación del archivo.'));
    }
    if (!fechaReporte) {
      // Sin fecha reconocible en el archivo (pasa más seguido en Excel/CSV,
      // que no siempre trae la fecha del reporte en una celda propia):
      // usamos la fecha de hoy, que es el uso real (se sube el reporte del
      // día). Se puede corregir a mano en la pantalla de revisión si hiciera falta.
      fechaReporte = new Date().toISOString().slice(0, 10);
    }

    req.session.desayunoPendiente = { fechaReporte, filas, nombreArchivo: req.file.originalname };
    res.redirect('/desayuno/revisar');
  } catch (e) {
    console.error('Error importando reporte de desayuno:', e.message, e.cause || '');
    fs.unlink(req.file.path, () => {});
    res.redirect('/desayuno?msg=' + encodeURIComponent(esPdf ? mensajeErrorGemini(e) : ('Error al leer el archivo: ' + e.message)));
  }
});

router.get('/revisar', async (req, res) => {
  const pendiente = req.session.desayunoPendiente;
  if (!pendiente) return res.redirect('/desayuno');

  // enriquecerFila espera los nombres de columna tal como los devuelve la
  // base (snake_case) — acá todavía estamos con las filas recién leídas
  // del archivo (camelCase), así que se traducen antes de pasarlas.
  const filasEnriquecidas = pendiente.filas.map(f => ({
    ...enriquecerFila({
      group_name: f.groupName,
      special_request: f.specialRequest,
      ttl_pkg_amt: f.ttlPkgAmt,
      membership_level: f.membershipLevel,
    }),
    ...f,
  }));

  const yaExistente = await db.get2("SELECT COUNT(*)::int AS total FROM desayuno_habitaciones WHERE fecha_reporte=$1", [pendiente.fechaReporte]);

  res.render('desayuno_revisar', {
    fechaReporte: pendiente.fechaReporte,
    nombreArchivo: pendiente.nombreArchivo,
    filas: filasEnriquecidas,
    totalFilas: filasEnriquecidas.length,
    sinDesayuno: filasEnriquecidas.filter(f => !f.bkfIncluido).length,
    conTR: filasEnriquecidas.filter(f => f.tieneTR).length,
    tripulacion: filasEnriquecidas.filter(f => f.tripulacionDe).length,
    reemplazaFilas: yaExistente?.total || 0,
  });
});

router.post('/aplicar', async (req, res) => {
  const pendiente = req.session.desayunoPendiente;
  if (!pendiente) return res.redirect('/desayuno');

  await db.run2("DELETE FROM desayuno_habitaciones WHERE fecha_reporte=$1", [pendiente.fechaReporte]);
  for (const f of pendiente.filas) {
    await db.run2(
      `INSERT INTO desayuno_habitaciones
        (fecha_reporte, habitacion, nombre_huesped, membership_level, adultos, ninos,
         fecha_llegada, fecha_salida, estado_reserva, group_name, company_name, special_request, ttl_pkg_amt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        pendiente.fechaReporte, f.habitacion, f.nombre || '', f.membershipLevel || '',
        f.adultos || 0, f.ninos || 0,
        f.fechaLlegada || null, f.fechaSalida || null,
        f.estado || '', f.groupName || '', f.companyName || '', f.specialRequest || '',
        f.ttlPkgAmt || 0,
      ]
    );
  }

  delete req.session.desayunoPendiente;
  res.redirect('/desayuno?msg=importado');
});

router.post('/cancelar', (req, res) => {
  delete req.session.desayunoPendiente;
  res.redirect('/desayuno');
});

module.exports = router;
