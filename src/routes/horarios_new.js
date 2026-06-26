const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');
const ExcelJS = require('exceljs');

const SECTORES = [
  'Supervisores','Comis de Recepción','Panadería',
  'Pastelería AM','Pastelería PM','Faro AM','Faro PM',
  'Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'
];

const ESTADOS = ['OFF','VAC','RECOFF','FERIADO','LICENCIA','CUMPLE','MUDANZA'];

// Obtener lunes de la semana de una fecha dada
function getLunes(fechaStr) {
  const d = new Date(fechaStr + 'T00:00:00');
  const day = d.getDay(); // 0=dom, 1=lun
  const diff = (day === 0) ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

// Obtener los 7 días de la semana a partir del lunes
function getDiasSemana(lunes) {
  const dias = [];
  const d = new Date(lunes + 'T00:00:00');
  for (let i = 0; i < 7; i++) {
    dias.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return dias;
}

// ── GET / ─────────────────────────────────────────────
router.get('/', loginRequerido, async (req, res) => {
  const hoy    = new Date().toISOString().split('T')[0];
  const lunes  = getLunes(req.query.fecha || hoy);
  const dias   = getDiasSemana(lunes);

  // Traer todos los empleados activos con sector
  const empleados = await db.all2(`
    SELECT id, nombre, puesto, departamento
    FROM usuarios
    WHERE activo = 1
    ORDER BY
      CASE departamento
        WHEN 'Supervisores'      THEN 1
        WHEN 'Comis de Recepción' THEN 2
        WHEN 'Panadería'         THEN 3
        WHEN 'Pastelería AM'     THEN 4
        WHEN 'Pastelería PM'     THEN 5
        WHEN 'Faro AM'           THEN 6
        WHEN 'Faro PM'           THEN 7
        WHEN 'Nocturno'          THEN 8
        WHEN 'BQTs Fríos'        THEN 9
        WHEN 'BQTs Calientes'    THEN 10
        WHEN 'Farolito'          THEN 11
        WHEN 'Cocina I+D'        THEN 12
        ELSE 99
      END, nombre
  `);

  // Traer horarios de la semana
  const horariosRaw = await db.all2(`
    SELECT usuario_id, fecha::text, valor
    FROM horarios_semanales
    WHERE fecha >= $1 AND fecha <= $2
  `, [dias[0], dias[6]]);

  // Convertir a mapa { usuario_id: { fecha: valor } }
  const horariosMap = {};
  horariosRaw.forEach(h => {
    if (!horariosMap[h.usuario_id]) horariosMap[h.usuario_id] = {};
    horariosMap[h.usuario_id][h.fecha] = h.valor;
  });

  // Agrupar empleados por sector
  const porSector = {};
  empleados.forEach(e => {
    const sector = e.departamento || 'Sin sector';
    if (!porSector[sector]) porSector[sector] = [];
    porSector[sector].push(e);
  });

  // Alertas de cobertura — sectores sin nadie asignado en algún día
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

  res.render('horarios', {
    path: 'horarios', lunes, dias, porSector, horariosMap,
    SECTORES, ESTADOS, alertas,
    semanaAnterior: getLunes(new Date(lunes + 'T00:00:00').setDate(new Date(lunes + 'T00:00:00').getDate() - 7) && new Date(new Date(lunes + 'T00:00:00').setDate(new Date(lunes + 'T00:00:00').getDate() - 7)).toISOString().split('T')[0]),
    semanaSiguiente: getLunes(dias[7] || dias[6])
  });
});

// ── POST /celda — guardar celda individual ─────────────
router.post('/celda', loginRequerido, async (req, res) => {
  const { usuario_id, fecha, valor } = req.body;
  try {
    if (!valor || valor.trim() === '') {
      await db.run2('DELETE FROM horarios_semanales WHERE usuario_id=$1 AND fecha=$2', [parseInt(usuario_id), fecha]);
    } else {
      await db.run2(`
        INSERT INTO horarios_semanales (usuario_id, fecha, valor)
        VALUES ($1, $2, $3)
        ON CONFLICT (usuario_id, fecha) DO UPDATE SET valor = $3
      `, [parseInt(usuario_id), fecha, valor.trim().toUpperCase()]);
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('Error guardando celda:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── POST /copiar-semana — copiar semana anterior ───────
router.post('/copiar-semana', loginRequerido, async (req, res) => {
  const { lunes_destino } = req.body;
  try {
    const lunesOrigen = getLunes(new Date(new Date(lunes_destino + 'T00:00:00').setDate(new Date(lunes_destino + 'T00:00:00').getDate() - 7)).toISOString().split('T')[0]);
    const diasOrigen  = getDiasSemana(lunesOrigen);
    const diasDestino = getDiasSemana(lunes_destino);

    const horariosOrigen = await db.all2(`
      SELECT usuario_id, fecha::text, valor
      FROM horarios_semanales
      WHERE fecha >= $1 AND fecha <= $2
    `, [diasOrigen[0], diasOrigen[6]]);

    for (const h of horariosOrigen) {
      const idx = diasOrigen.indexOf(h.fecha);
      if (idx === -1) continue;
      const fechaDestino = diasDestino[idx];
      await db.run2(`
        INSERT INTO horarios_semanales (usuario_id, fecha, valor)
        VALUES ($1, $2, $3)
        ON CONFLICT (usuario_id, fecha) DO UPDATE SET valor = $3
      `, [h.usuario_id, fechaDestino, h.valor]);
    }

    res.redirect('/horarios?fecha=' + lunes_destino);
  } catch(e) {
    console.error('Error copiando semana:', e.message);
    res.redirect('/horarios?fecha=' + lunes_destino);
  }
});

// ── GET /excel — exportar semana ───────────────────────
router.get('/excel', loginRequerido, async (req, res) => {
  const lunes = getLunes(req.query.fecha || new Date().toISOString().split('T')[0]);
  const dias  = getDiasSemana(lunes);
  const DIAS_NOMBRES = ['L','M','M','J','V','S','D'];

  const empleados = await db.all2(`
    SELECT id, nombre, puesto, departamento FROM usuarios WHERE activo=1
    ORDER BY CASE departamento
      WHEN 'Supervisores' THEN 1 WHEN 'Comis de Recepción' THEN 2
      WHEN 'Panadería' THEN 3 WHEN 'Pastelería AM' THEN 4
      WHEN 'Pastelería PM' THEN 5 WHEN 'Faro AM' THEN 6
      WHEN 'Faro PM' THEN 7 WHEN 'Nocturno' THEN 8
      WHEN 'BQTs Fríos' THEN 9 WHEN 'BQTs Calientes' THEN 10
      WHEN 'Farolito' THEN 11 WHEN 'Cocina I+D' THEN 12
      ELSE 99 END, nombre
  `);

  const horariosRaw = await db.all2(`
    SELECT usuario_id, fecha::text, valor FROM horarios_semanales
    WHERE fecha >= $1 AND fecha <= $2
  `, [dias[0], dias[6]]);

  const horariosMap = {};
  horariosRaw.forEach(h => {
    if (!horariosMap[h.usuario_id]) horariosMap[h.usuario_id] = {};
    horariosMap[h.usuario_id][h.fecha] = h.valor;
  });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Horarios');

  // Título
  ws.mergeCells(`A1:J1`);
  const titulo = ws.getCell('A1');
  titulo.value = `HORARIOS — HILTON BUENOS AIRES — Semana del ${dias[0]} al ${dias[6]}`;
  titulo.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  titulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  titulo.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  // Encabezado
  const encRow = ws.addRow(['NOMBRE', 'SECTOR', ...dias.map((d,i) => `${DIAS_NOMBRES[i]}\n${d.slice(5)}`)]);
  encRow.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
  });
  ws.getRow(2).height = 30;

  // Colores por estado
  const colores = {
    'OFF': 'FFFBBF24', 'VAC': 'FFEF4444', 'RECOFF': 'FF22C55E',
    'FERIADO': 'FFEF4444', 'LICENCIA': 'FFEC4899', 'CUMPLE': 'FFA855F7', 'MUDANZA': 'FFFB923C'
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
      // Fila de sector
      const sRow = ws.addRow([emp.departamento || 'Sin sector', '', ...Array(7).fill('')]);
      ws.mergeCells(`A${sRow.number}:J${sRow.number}`);
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

  ws.columns = [{ width: 24 }, { width: 18 }, ...Array(7).fill({ width: 10 })];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=horarios_semana_${lunes}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

module.exports = router;
