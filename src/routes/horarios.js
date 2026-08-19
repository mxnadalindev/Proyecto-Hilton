const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido, requiereDepartamento } = require('./middleware');
router.use(loginRequerido, requiereDepartamento('/horarios'));
const ExcelJS = require('exceljs');
const { getLunes, sumarDias, getDiasRango } = require('../utils/fechas');
const { calcularRecoffPendiente, mapRecoffUsados } = require('../services/recoff');

const SECTORES = [
  'Supervisores','Comis de Recepción','Panadería',
  'Pastelería AM','Pastelería PM','Faro AM','Faro PM',
  'Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'
];

const ESTADOS = ['OFF','VAC','RECOFF','LIBRE','ART','LICENCIA','CUMPLE','MUDANZA'];

// CASE WHEN para ordenar por el mismo orden que SECTORES, armado una sola vez
// a partir del array (antes estaba repetido a mano en la ruta / y en /excel).
const ORDEN_DEPARTAMENTO_SQL = `CASE departamento
  ${SECTORES.map((s, i) => `WHEN '${s}' THEN ${i + 1}`).join('\n  ')}
  ELSE 99
END`;

// Resuelve inicio/fin a partir de los distintos formatos de query que puede recibir
// (?inicio=&fin=  |  ?fecha=  viejo, semana completa  |  nada, semana actual)
function resolverRango(query) {
  const hoy = new Date().toISOString().split('T')[0];
  if (query.inicio) {
    return { inicio: query.inicio, fin: query.fin || query.inicio };
  }
  if (query.fecha) {
    const inicio = getLunes(query.fecha);
    return { inicio, fin: sumarDias(inicio, 6) };
  }
  const inicio = getLunes(hoy);
  return { inicio, fin: sumarDias(inicio, 6) };
}

// Solo supervisores y admins pueden borrar horarios ya cargados
function esSupervisorOAdmin(req) {
  const rol = req.session?.usuario?.rol;
  return rol === 'supervisor' || rol === 'admin';
}

router.get('/', async (req, res) => {
  const { inicio, fin } = resolverRango(req.query);
  const dias = getDiasRango(inicio, fin);

  const empleados = await db.all2(`
    SELECT id, nombre, puesto, departamento, recoff_adeudado
    FROM usuarios
    WHERE activo = 1
    ORDER BY ${ORDEN_DEPARTAMENTO_SQL}, nombre
  `);

  // Cuántos RECOFF tiene puestos cada uno en TODA la grilla (no solo el rango visible)
  const recoffUsadosMap = await mapRecoffUsados();
  empleados.forEach(e => {
    e.recoff_pendiente = (e.recoff_adeudado || 0) - (recoffUsadosMap[e.id] || 0);
  });

  const horariosRaw = await db.all2(`
    SELECT usuario_id, fecha::text, valor, sector_dia
    FROM horarios_semanales
    WHERE fecha >= $1 AND fecha <= $2
  `, [dias[0], dias[dias.length - 1]]);

  const horariosMap = {};
  const sectorDiaMap = {};
  horariosRaw.forEach(h => {
    if (!horariosMap[h.usuario_id]) horariosMap[h.usuario_id] = {};
    horariosMap[h.usuario_id][h.fecha] = h.valor;
    if (h.sector_dia) {
      if (!sectorDiaMap[h.usuario_id]) sectorDiaMap[h.usuario_id] = {};
      sectorDiaMap[h.usuario_id][h.fecha] = h.sector_dia;
    }
  });

  const porSector = {};
  empleados.forEach(e => {
    const sector = e.departamento || 'Sin sector';
    if (!porSector[sector]) porSector[sector] = [];
    porSector[sector].push(e);
  });

  const alertas = [];
  SECTORES.forEach(sector => {
    if (!porSector[sector]) return;
    dias.forEach(dia => {
      const tieneAlguien = porSector[sector].some(e => {
        const val = horariosMap[e.id]?.[dia];
        return val && !ESTADOS.includes(val.toUpperCase());
      });
      if (!tieneAlguien) {
        const fecha = new Date(dia + 'T00:00:00');
        const nombreDia = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][fecha.getDay()];
        alertas.push({ sector, dia, nombreDia });
      }
    });
  });

  // Navegación: mueve todo el rango hacia atrás/adelante según su propia duración,
  // así un rango de 3 días sigue siendo de 3 días al navegar, y una semana completa
  // sigue siendo una semana completa.
  const duracion = dias.length;
  const rangoAnterior = { inicio: sumarDias(inicio, -duracion), fin: sumarDias(fin, -duracion) };
  const rangoSiguiente = { inicio: sumarDias(inicio, duracion), fin: sumarDias(fin, duracion) };

  res.render('horarios', {
    path: 'horarios',
    inicio, fin, dias, porSector, horariosMap, sectorDiaMap,
    SECTORES, ESTADOS, alertas,
    rangoAnterior, rangoSiguiente,
    puedeReiniciar: esSupervisorOAdmin(req),
    // compatibilidad con la vista vieja, por si todavía queda alguna referencia a "lunes"
    lunes: inicio
  });
});

router.post('/celda', async (req, res) => {
  const { usuario_id, fecha, valor } = req.body;
  try {
    const valorNuevo = (valor || '').trim().toUpperCase();

    if (!valor || valor.trim() === '') {
      await db.run2('DELETE FROM horarios_semanales WHERE usuario_id=$1 AND fecha=$2', [parseInt(usuario_id), fecha]);
    } else {
      await db.run2(`
        INSERT INTO horarios_semanales (usuario_id, fecha, valor)
        VALUES ($1, $2, $3)
        ON CONFLICT (usuario_id, fecha) DO UPDATE SET valor = $3
      `, [parseInt(usuario_id), fecha, valorNuevo]);
    }

    const pendiente = await calcularRecoffPendiente(usuario_id);

    res.json({ ok: true, recoff_pendiente: pendiente });
  } catch(e) {
    console.error('Error guardando celda:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// Copia el rango inmediatamente anterior (misma duración) al rango destino
router.post('/copiar-semana', async (req, res) => {
  const { inicio_destino, fin_destino, lunes_destino } = req.body;

  // Compatibilidad: si viene el campo viejo "lunes_destino", tratamos como semana completa
  const destInicio = inicio_destino || lunes_destino;
  const destFin     = fin_destino || (lunes_destino ? sumarDias(lunes_destino, 6) : destInicio);

  try {
    const diasDestino = getDiasRango(destInicio, destFin);
    const duracion = diasDestino.length;
    const origenInicio = sumarDias(destInicio, -duracion);
    const origenFin     = sumarDias(destFin, -duracion);
    const diasOrigen = getDiasRango(origenInicio, origenFin);

    const horariosOrigen = await db.all2(`
      SELECT usuario_id, fecha::text, valor
      FROM horarios_semanales
      WHERE fecha >= $1 AND fecha <= $2
    `, [diasOrigen[0], diasOrigen[diasOrigen.length - 1]]);

    for (const h of horariosOrigen) {
      const idx = diasOrigen.indexOf(h.fecha);
      if (idx === -1 || idx >= diasDestino.length) continue;
      await db.run2(`
        INSERT INTO horarios_semanales (usuario_id, fecha, valor)
        VALUES ($1, $2, $3)
        ON CONFLICT (usuario_id, fecha) DO UPDATE SET valor = $3
      `, [h.usuario_id, diasDestino[idx], h.valor]);
    }

    res.redirect(`/horarios?inicio=${destInicio}&fin=${destFin}`);
  } catch(e) {
    console.error('Error copiando semana:', e.message);
    res.redirect(`/horarios?inicio=${destInicio}&fin=${destFin}`);
  }
});

router.get('/excel', async (req, res) => {
  const { inicio, fin } = resolverRango(req.query);
  const dias = getDiasRango(inicio, fin);
  const NOMBRES_DIA = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

  const empleados = await db.all2(`
    SELECT id, nombre, puesto, departamento FROM usuarios WHERE activo=1
    ORDER BY ${ORDEN_DEPARTAMENTO_SQL}, nombre
  `);

  const horariosRaw = await db.all2(`
    SELECT usuario_id, fecha::text, valor FROM horarios_semanales
    WHERE fecha >= $1 AND fecha <= $2
  `, [dias[0], dias[dias.length - 1]]);

  const horariosMap = {};
  horariosRaw.forEach(h => {
    if (!horariosMap[h.usuario_id]) horariosMap[h.usuario_id] = {};
    horariosMap[h.usuario_id][h.fecha] = h.valor;
  });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Horarios');

  const ultimaCol = String.fromCharCode('A'.charCodeAt(0) + 1 + dias.length); // 2 cols fijas + N días
  ws.mergeCells(`A1:${ultimaCol}1`);
  const titulo = ws.getCell('A1');
  titulo.value = `HORARIOS — HILTON BUENOS AIRES — ${dias[0]} al ${dias[dias.length - 1]}`;
  titulo.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  titulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  titulo.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  const encRow = ws.addRow(['NOMBRE', 'SECTOR', ...dias.map(d => {
    const fecha = new Date(d + 'T00:00:00');
    return `${NOMBRES_DIA[fecha.getDay()]}\n${d.slice(5)}`;
  })]);
  encRow.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
  });
  ws.getRow(2).height = 30;

  const colores = {
    OFF:'FFFBBF24', VAC:'FFDC2626', RECOFF:'FF22C55E',
    LIBRE:'FFDC2626', FERIADO:'FFDC2626', ART:'FFDC2626',
    LICENCIA:'FFDC2626', CUMPLE:'FFDC2626', MUDANZA:'FFDC2626'
  };
  const coloresSector = [
    'FFDBEAFE','FFECFDF5','FFFEFCE8','FFFFF7ED','FFFDF4FF',
    'FFF0FDF4','FFEFF6FF','FFFDF2F8','FFFFF7F0','FFEEF2FF','FFF7FEE7','FFFEF9C3'
  ];

  let sectorActual = null;
  let sectorIdx = -1;

  empleados.forEach(emp => {
    if (emp.departamento !== sectorActual) {
      sectorActual = emp.departamento;
      sectorIdx++;
      const sRow = ws.addRow([emp.departamento || 'Sin sector', '', ...Array(dias.length).fill('')]);
      ws.mergeCells(`A${sRow.number}:${ultimaCol}${sRow.number}`);
      sRow.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF1E3A5F' } };
      sRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: coloresSector[sectorIdx % coloresSector.length] } };
      sRow.getCell(1).alignment = { horizontal: 'center' };
      sRow.height = 18;
    }
    const fila = [emp.nombre, emp.departamento || ''];
    dias.forEach(d => fila.push(horariosMap[emp.id]?.[d] || ''));
    const row = ws.addRow(fila);
    row.height = 18;
    row.eachCell((c, col) => {
      c.font = { size: 10 };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } }, right: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
      if (col === 1) { c.alignment.horizontal = 'left'; c.font.bold = true; }
      if (col > 2) {
        const val = c.value?.toString().toUpperCase();
        if (val && colores[val]) {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colores[val] } };
          c.font = { bold: true, size: 10 };
        }
      }
    });
  });

  ws.columns = [{ width: 24 }, { width: 18 }, ...Array(dias.length).fill({ width: 10 })];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=horarios_${inicio}_a_${fin}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

// ── POST /reiniciar-semana ────────────────────────────
// Solo supervisores y admins pueden borrar horarios ya cargados
router.post('/reiniciar-semana', async (req, res) => {
  if (!esSupervisorOAdmin(req)) {
    return res.redirect('/horarios?msg=' + encodeURIComponent('Solo un supervisor puede reiniciar horarios ya cargados.'));
  }

  const { inicio, fin, lunes } = req.body;
  const rangoInicio = inicio || lunes;
  const rangoFin     = fin || (lunes ? sumarDias(lunes, 6) : rangoInicio);
  try {
    const dias = getDiasRango(rangoInicio, rangoFin);
    await db.run2(
      'DELETE FROM horarios_semanales WHERE fecha >= $1 AND fecha <= $2',
      [dias[0], dias[dias.length - 1]]
    );
    res.redirect(`/horarios?inicio=${rangoInicio}&fin=${rangoFin}&msg=reiniciado`);
  } catch(e) {
    console.error('Error reiniciando semana:', e.message);
    res.redirect(`/horarios?inicio=${rangoInicio}&fin=${rangoFin}`);
  }
});

module.exports = router;
