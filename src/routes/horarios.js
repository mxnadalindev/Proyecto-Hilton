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

// ── Helpers de fecha ────────────────────────────────────

// Se mantienen por compatibilidad con enlaces viejos que todavía manden ?fecha=
function getLunes(fechaStr) {
  const d = new Date(fechaStr + 'T00:00:00');
  const day = d.getDay();
  const diff = (day === 0) ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

function getDiasSemana(lunes) {
  const dias = [];
  const d = new Date(lunes + 'T00:00:00');
  for (let i = 0; i < 7; i++) {
    dias.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return dias;
}

function sumarDias(fechaStr, n) {
  const d = new Date(fechaStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// Nuevo: rango libre entre dos fechas (inclusive), cualquier cantidad de días
function getDiasRango(inicioStr, finStr) {
  const dias = [];
  let d = new Date(inicioStr + 'T00:00:00');
  const dFin = new Date(finStr + 'T00:00:00');
  let cursor = d <= dFin ? d : dFin;
  let limite = d <= dFin ? dFin : d;
  while (cursor <= limite) {
    dias.push(cursor.toISOString().split('T')[0]);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dias;
}

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

router.get('/', loginRequerido, async (req, res) => {
  const { inicio, fin } = resolverRango(req.query);
  const dias = getDiasRango(inicio, fin);

  const empleados = await db.all2(`
    SELECT id, nombre, puesto, departamento
    FROM usuarios
    WHERE activo = 1
    ORDER BY
      CASE departamento
        WHEN 'Supervisores'       THEN 1
        WHEN 'Comis de Recepción' THEN 2
        WHEN 'Panadería'          THEN 3
        WHEN 'Pastelería AM'      THEN 4
        WHEN 'Pastelería PM'      THEN 5
        WHEN 'Faro AM'            THEN 6
        WHEN 'Faro PM'            THEN 7
        WHEN 'Nocturno'           THEN 8
        WHEN 'BQTs Fríos'         THEN 9
        WHEN 'BQTs Calientes'     THEN 10
        WHEN 'Farolito'           THEN 11
        WHEN 'Cocina I+D'         THEN 12
        ELSE 99
      END, nombre
  `);

  const horariosRaw = await db.all2(`
    SELECT usuario_id, fecha::text, valor
    FROM horarios_semanales
    WHERE fecha >= $1 AND fecha <= $2
  `, [dias[0], dias[dias.length - 1]]);

  const horariosMap = {};
  horariosRaw.forEach(h => {
    if (!horariosMap[h.usuario_id]) horariosMap[h.usuario_id] = {};
    horariosMap[h.usuario_id][h.fecha] = h.valor;
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
    inicio, fin, dias, porSector, horariosMap,
    SECTORES, ESTADOS, alertas,
    rangoAnterior, rangoSiguiente,
    // compatibilidad con la vista vieja, por si todavía queda alguna referencia a "lunes"
    lunes: inicio
  });
});

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

// Copia el rango inmediatamente anterior (misma duración) al rango destino
router.post('/copiar-semana', loginRequerido, async (req, res) => {
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

router.get('/excel', loginRequerido, async (req, res) => {
  const { inicio, fin } = resolverRango(req.query);
  const dias = getDiasRango(inicio, fin);
  const NOMBRES_DIA = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

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
    OFF:'FFFBBF24', VAC:'FFEF4444', RECOFF:'FF22C55E',
    FERIADO:'FFEF4444', LICENCIA:'FFEC4899', CUMPLE:'FFA855F7', MUDANZA:'FFFB923C'
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
router.post('/reiniciar-semana', loginRequerido, async (req, res) => {
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
