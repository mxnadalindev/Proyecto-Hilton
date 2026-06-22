const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');
const ExcelJS = require('exceljs');

const TURNOS = {
  manana: { nombre: 'Mañana', inicio: '06:00', fin: '14:00' },
  tarde:  { nombre: 'Tarde',  inicio: '14:00', fin: '22:00' },
  noche:  { nombre: 'Noche',  inicio: '22:00', fin: '06:00' }
};

router.get('/', loginRequerido, async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().split('T')[0];
  const horarios = await db.all2(`
    SELECT h.*, u.nombre as empleado, u.puesto, u.legajo, e.nombre as evento_nombre
    FROM horarios h JOIN usuarios u ON h.usuario_id = u.id
    LEFT JOIN eventos e ON h.evento_id = e.id
    WHERE h.fecha = $1 ORDER BY h.turno, u.nombre
  `, [fecha]);

  const eventosRaw = await db.all2("SELECT id,nombre,fecha FROM eventos ORDER BY fecha DESC LIMIT 20");
  const eventos = await Promise.all(eventosRaw.map(async e => {
    const pids = await db.all2("SELECT usuario_id FROM evento_personal WHERE evento_id=$1", [e.id]);
    return { ...e, personal_ids: pids.map(p => p.usuario_id) };
  }));

  const todoPersonal = await db.all2("SELECT id,nombre,puesto FROM usuarios WHERE activo=1 ORDER BY nombre");
  const porTurno = { manana:[], tarde:[], noche:[] };
  horarios.forEach(h => { if(porTurno[h.turno]) porTurno[h.turno].push(h); });

  res.render('horarios', { horarios, porTurno, fecha, eventos, TURNOS, totalAsignados: horarios.length, todoPersonal });
});

router.post('/generar', loginRequerido, async (req, res) => {
  const { fecha, evento_id, cant_manana, cant_tarde, cant_noche } = req.body;

  let personal;
  if (evento_id) {
    personal = await db.all2(`
      SELECT u.id, u.nombre, u.puesto FROM evento_personal ep
      JOIN usuarios u ON ep.usuario_id = u.id
      WHERE ep.evento_id = $1 AND u.activo = 1
      ORDER BY CASE u.puesto
        WHEN 'Chef' THEN 1 WHEN 'Subchef' THEN 2
        WHEN 'Encargado de cocina' THEN 3 WHEN 'Cocinero' THEN 4
        WHEN 'Ayudante de cocina' THEN 5 WHEN 'Pastelero' THEN 6
        WHEN 'Panadero' THEN 7 ELSE 8 END, u.nombre
    `, [evento_id]);
    if (!personal.length) {
      personal = await db.all2(`SELECT id,nombre,puesto FROM usuarios WHERE activo=1 ORDER BY CASE puesto WHEN 'Chef' THEN 1 WHEN 'Subchef' THEN 2 WHEN 'Encargado de cocina' THEN 3 WHEN 'Cocinero' THEN 4 WHEN 'Ayudante de cocina' THEN 5 ELSE 6 END, nombre`);
    }
  } else {
    personal = await db.all2(`SELECT id,nombre,puesto FROM usuarios WHERE activo=1 ORDER BY CASE puesto WHEN 'Chef' THEN 1 WHEN 'Subchef' THEN 2 WHEN 'Encargado de cocina' THEN 3 WHEN 'Cocinero' THEN 4 WHEN 'Ayudante de cocina' THEN 5 ELSE 6 END, nombre`);
  }

  if (!personal.length) return res.redirect('/horarios?fecha='+fecha);
  await db.run2("DELETE FROM horarios WHERE fecha=$1", [fecha]);

  const cantidades = { manana: parseInt(cant_manana)||0, tarde: parseInt(cant_tarde)||0, noche: parseInt(cant_noche)||0 };
  const seleccion  = {
    manana: req.body.sel_manana ? [].concat(req.body.sel_manana) : null,
    tarde:  req.body.sel_tarde  ? [].concat(req.body.sel_tarde)  : null,
    noche:  req.body.sel_noche  ? [].concat(req.body.sel_noche)  : null,
  };

  let idx = 0;
  for (const [turno, info] of Object.entries(TURNOS)) {
    const sel = seleccion[turno];
    if (sel && sel.length > 0) {
      for (const uid of sel) {
        await db.run2(
          "INSERT INTO horarios (fecha,evento_id,turno,hora_inicio,hora_fin,usuario_id,estado) VALUES ($1,$2,$3,$4,$5,$6,'asignado')",
          [fecha, evento_id||null, turno, info.inicio, info.fin, parseInt(uid)]
        );
      }
    } else {
      for (let i=0; i<cantidades[turno]; i++) {
        const emp = personal[idx % personal.length];
        await db.run2(
          "INSERT INTO horarios (fecha,evento_id,turno,hora_inicio,hora_fin,usuario_id,estado) VALUES ($1,$2,$3,$4,$5,$6,'asignado')",
          [fecha, evento_id||null, turno, info.inicio, info.fin, emp.id]
        );
        idx++;
      }
    }
  }
  res.redirect('/horarios?fecha='+fecha);
});

router.get('/excel', loginRequerido, async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().split('T')[0];
  const horarios = await db.all2(`
    SELECT h.turno, h.hora_inicio, h.hora_fin, h.seccion,
           u.nombre as empleado, u.puesto, u.legajo,
           e.nombre as evento_nombre
    FROM horarios h JOIN usuarios u ON h.usuario_id = u.id
    LEFT JOIN eventos e ON h.evento_id = e.id
    WHERE h.fecha = $1 ORDER BY h.turno, u.nombre
  `, [fecha]);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Horarios');

  ws.mergeCells('A1:G1');
  const t = ws.getCell('A1');
  t.value = `HORARIOS — HILTON BUENOS AIRES — ${fecha}`;
  t.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 30;
  ws.addRow([]);

  const enc = ws.addRow(['Turno', 'Horario', 'Legajo', 'Nombre', 'Puesto', 'Sección', 'Evento']);
  enc.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
    c.alignment = { horizontal: 'center' };
  });

  const cols = { manana: 'FFFEF3C7', tarde: 'FFFFEDD5', noche: 'FFEDE9FE' };
  const noms = { manana: '☀️ MAÑANA', tarde: '🌤️ TARDE', noche: '🌙 NOCHE' };
  let tc = null;

  horarios.forEach(h => {
    if (h.turno !== tc) {
      tc = h.turno;
      const fh = ws.addRow([noms[h.turno]]);
      ws.mergeCells(`A${fh.number}:G${fh.number}`);
      fh.getCell(1).font = { bold: true };
      fh.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cols[h.turno] } };
      fh.getCell(1).alignment = { horizontal: 'center' };
    }
    const fr = ws.addRow([
      noms[h.turno],
      `${h.hora_inicio} — ${h.hora_fin}`,
      h.legajo || '—',
      h.empleado,
      h.puesto || '—',
      h.seccion || '—',
      h.evento_nombre || '—'
    ]);
    fr.eachCell(c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cols[h.turno] || 'FFEEEEEE' } };
      c.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
    });
    fr.height = 20;
  });

  if (!horarios.length) ws.addRow(['Sin horarios para esta fecha']);

  ws.columns = [
    { width: 14 }, { width: 18 }, { width: 10 },
    { width: 28 }, { width: 22 }, { width: 20 }, { width: 24 }
  ];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=horarios_${fecha}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

router.post('/asignar', loginRequerido, async (req, res) => {
  const { fecha, turno, usuario_id, evento_id } = req.body;
  const info = TURNOS[turno];
  if (!info) return res.redirect('/horarios?fecha='+fecha);
  await db.run2(
    "INSERT INTO horarios (fecha,evento_id,turno,hora_inicio,hora_fin,usuario_id) VALUES ($1,$2,$3,$4,$5,$6)",
    [fecha, evento_id||null, turno, info.inicio, info.fin, parseInt(usuario_id)]
  );
  res.redirect('/horarios?fecha='+fecha);
});

router.post('/:id/eliminar', loginRequerido, async (req, res) => {
  const h = await db.get2("SELECT fecha FROM horarios WHERE id=$1", [req.params.id]);
  await db.run2("DELETE FROM horarios WHERE id=$1", [req.params.id]);
  res.redirect('/horarios?fecha='+(h?.fecha||''));
});

module.exports = router;
