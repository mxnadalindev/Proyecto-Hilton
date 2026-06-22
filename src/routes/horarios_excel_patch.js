// ── Reemplazar la ruta GET /excel en horarios.js ──

router.get('/excel', loginRequerido, async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().split('T')[0];
  const horarios = await db.all2(`
    SELECT h.turno, h.hora_inicio, h.hora_fin, h.seccion,
           u.nombre as empleado, u.puesto, u.legajo,
           e.nombre as evento_nombre
    FROM horarios h
    JOIN usuarios u ON h.usuario_id = u.id
    LEFT JOIN eventos e ON h.evento_id = e.id
    WHERE h.fecha = $1
    ORDER BY h.turno, u.nombre
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

  const cols  = { manana: 'FFFEF3C7', tarde: 'FFFFEDD5', noche: 'FFEDE9FE' };
  const noms  = { manana: '☀️ MAÑANA', tarde: '🌤️ TARDE', noche: '🌙 NOCHE' };
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
