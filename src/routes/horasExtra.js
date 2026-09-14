const express = require('express');
const router = express.Router();
const db = require('../db/database');
const ExcelJS = require('exceljs');
const { loginRequerido, requiereDepartamento } = require('./middleware');
// Los cocineros reales NO se guardan con departamento='cocina' — se
// guardan con el nombre de su sector (Panadería, Pastelería AM, etc.), la
// misma lista que ya usa Miembro de equipo para armar su listado. Se
// reusa esa lista (en vez de filtrar por 'cocina' a secas) para que acá
// aparezcan exactamente los mismos empleados que ya ves en Miembro de
// equipo, ni más ni menos.
const { SECTORES } = require('./personal');
// Igual que en obtenerPersonal() de personal.js: las cuentas con rol admin
// son credenciales para entrar al sistema, no personal de cocina — sin
// este filtro aparecían mezcladas acá como si fueran un cocinero más.
const NO_ADMIN = `LOWER(rol) != 'admin'`;

router.use(loginRequerido, requiereDepartamento('/horas-extra'));

// Solo admin: esto es información sensible pensada para liquidar horas
// extra, no algo que un empleado común de cocina tenga que ver o cargar.
// .toLowerCase(): mismo motivo que en el resto del proyecto (el rol puede
// venir guardado con distinta capitalización según cómo se creó la cuenta).
function soloAdmin(req, res, next) {
  const rol = (req.session.usuario?.rol || '').toLowerCase();
  if (rol !== 'admin') return res.redirect('/inicio');
  next();
}
router.use(soloAdmin);

function mesActualYYYYMM() {
  return new Date().toISOString().slice(0, 7);
}
function nombreMes(mesYYYYMM) {
  return new Date(mesYYYYMM + '-01T00:00:00').toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
}

// Estilo de encabezado compartido entre /excel y /excel-historial — mismo
// criterio visual que ya usa horarios.js (mismos colores), para que las
// planillas del portal se sientan parte del mismo sistema.
function estilizarTitulo(ws, rango, texto) {
  ws.mergeCells(rango);
  const titulo = ws.getCell(rango.split(':')[0]);
  titulo.value = texto;
  titulo.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  titulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  titulo.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;
}
function estilizarEncabezado(row) {
  row.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  row.height = 22;
}

// ── Descarga en Excel de las horas extra de UN mes (el que se está
// viendo en pantalla) — lista fila por fila, con un resumen por empleado
// al final. ────────────────────────────────────────────────────────────
router.get('/excel', async (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : mesActualYYYYMM();
  try {
    const registros = await db.all2(`
      SELECT h.fecha::text AS fecha, h.horas, h.nota, h.creado_por_nombre,
             u.nombre AS empleado, u.puesto
      FROM horas_extra h JOIN usuarios u ON u.id = h.usuario_id
      WHERE to_char(h.fecha,'YYYY-MM') = $1
      ORDER BY u.nombre, h.fecha
    `, [mes]);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Horas extra');

    estilizarTitulo(ws, 'A1:F1', `HORAS EXTRA — COCINA — ${nombreMes(mes).toUpperCase()}`);
    estilizarEncabezado(ws.addRow(['FECHA', 'EMPLEADO', 'PUESTO', 'HORAS', 'NOTA', 'CARGADO POR']));

    registros.forEach(r => {
      const row = ws.addRow([r.fecha, r.empleado, r.puesto || '', Number(r.horas), r.nota || '', r.creado_por_nombre || '']);
      row.eachCell((c, col) => {
        c.font = { size: 10 };
        c.alignment = { horizontal: col === 2 ? 'left' : 'center', vertical: 'middle' };
        c.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
      });
    });

    // Resumen por empleado, separado por una fila en blanco.
    const porEmpleado = new Map();
    registros.forEach(r => porEmpleado.set(r.empleado, (porEmpleado.get(r.empleado) || 0) + Number(r.horas)));
    ws.addRow([]);
    estilizarEncabezado(ws.addRow(['', 'TOTAL POR EMPLEADO', '', '', '', '']));
    [...porEmpleado.entries()].sort((a, b) => b[1] - a[1]).forEach(([nombreEmp, total]) => {
      const row = ws.addRow(['', nombreEmp, '', Math.round(total * 10) / 10, '', '']);
      row.eachCell((c, col) => { c.font = { size: 10, bold: col === 4 }; c.alignment = { horizontal: col === 2 ? 'left' : 'center' }; });
    });

    ws.columns = [{ width: 13 }, { width: 26 }, { width: 20 }, { width: 10 }, { width: 30 }, { width: 20 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=horas_extra_${mes}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Error generando Excel de horas extra:', e.message);
    if (!res.headersSent) {
      res.redirect(`/horas-extra?mes=${mes}&msg=${encodeURIComponent('Error generando el Excel. Probá de nuevo.')}`);
    } else {
      res.end();
    }
  }
});

// ── Descarga en Excel de TODO el historial de horas extra cargado alguna
// vez, sin importar el mes — mismo criterio que /horarios/excel-historial:
// un listado (no una grilla), para que no importe cuántos meses de datos
// haya acumulados. ──────────────────────────────────────────────────────
router.get('/excel-historial', async (req, res) => {
  try {
    const registros = await db.all2(`
      SELECT h.fecha::text AS fecha, h.horas, h.nota, h.creado_por_nombre,
             u.nombre AS empleado, u.puesto
      FROM horas_extra h JOIN usuarios u ON u.id = h.usuario_id
      ORDER BY h.fecha DESC, u.nombre
    `);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Historial');

    estilizarTitulo(ws, 'A1:F1', `HISTORIAL COMPLETO DE HORAS EXTRA — COCINA — generado ${new Date().toLocaleDateString('es-AR')}`);
    estilizarEncabezado(ws.addRow(['FECHA', 'EMPLEADO', 'PUESTO', 'HORAS', 'NOTA', 'CARGADO POR']));

    registros.forEach(r => {
      const row = ws.addRow([r.fecha, r.empleado, r.puesto || '', Number(r.horas), r.nota || '', r.creado_por_nombre || '']);
      row.eachCell((c, col) => {
        c.font = { size: 10 };
        c.alignment = { horizontal: col === 2 ? 'left' : 'center', vertical: 'middle' };
        c.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
      });
    });

    ws.columns = [{ width: 13 }, { width: 26 }, { width: 20 }, { width: 10 }, { width: 30 }, { width: 20 }];
    ws.autoFilter = { from: 'A2', to: 'F2' };
    ws.views = [{ state: 'frozen', ySplit: 2 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=historial_horas_extra_completo.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Error generando Excel de historial de horas extra:', e.message);
    if (!res.headersSent) {
      res.redirect(`/horas-extra?msg=${encodeURIComponent('Error generando el Excel. Probá de nuevo.')}`);
    } else {
      res.end();
    }
  }
});

// ── Informe principal: horas extra acumuladas por empleado, mes por mes ──
router.get('/', async (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : mesActualYYYYMM();
  try {
    const empleados = await db.all2(`
      SELECT id, nombre, puesto FROM usuarios
      WHERE activo = 1 AND departamento = ANY($1) AND ${NO_ADMIN}
      ORDER BY nombre
    `, [SECTORES]);

    const registros = await db.all2(`
      SELECT h.id, h.usuario_id, h.fecha::text AS fecha, h.horas, h.nota, h.creado_por_nombre
      FROM horas_extra h
      WHERE to_char(h.fecha, 'YYYY-MM') = $1
      ORDER BY h.fecha DESC, h.id DESC
    `, [mes]);

    // Agrupamos por empleado, incluyendo a los que no tienen ningún registro
    // este mes (para que el informe muestre 0hs y no simplemente los omita).
    const porEmpleado = new Map();
    empleados.forEach(e => porEmpleado.set(e.id, { id: e.id, nombre: e.nombre, puesto: e.puesto, totalHoras: 0, registros: [] }));
    registros.forEach(r => {
      // Antes, si un registro era de un empleado ya dado de baja, se armaba
      // igual una tarjeta "(empleado dado de baja)" en el carrusel — a
      // pedido, esta pantalla ahora es solo para el personal activo de
      // Cocina (igual que Miembro de equipo). El dato no se pierde: sigue
      // en la base tal cual, y sigue completo en el Excel del mes y en el
      // historial (esos dos no pasan por este filtro, salen directo de la
      // tabla horas_extra con un JOIN, sin importar si el empleado sigue
      // activo o no).
      if (!porEmpleado.has(r.usuario_id)) return;
      const e = porEmpleado.get(r.usuario_id);
      e.totalHoras += Number(r.horas) || 0;
      e.registros.push(r);
    });

    const filas = [...porEmpleado.values()].sort((a, b) => b.totalHoras - a.totalHoras || a.nombre.localeCompare(b.nombre));
    const totalGeneral = filas.reduce((n, f) => n + f.totalHoras, 0);

    const [anio, mesNum] = mes.split('-').map(Number);
    const mesAnterior = new Date(anio, mesNum - 2, 1).toISOString().slice(0, 7);
    const mesSiguienteDate = new Date(anio, mesNum, 1);
    const mesSiguiente = mesSiguienteDate.toISOString().slice(0, 7);
    const esMesActual = mes === mesActualYYYYMM();

    res.render('horas_extra', {
      mes, mesAnterior, mesSiguiente, esMesActual,
      empleadosActivos: empleados,
      filas, totalGeneral,
      msg: req.query.msg || null,
    });
  } catch (e) {
    console.error('Error cargando horas extra:', e.message);
    res.render('error', {
      mensaje: 'No se pudo cargar Horas extra. Probá de nuevo — si vuelve a pasar, avisale al admin.',
      volver: '/inicio',
    });
  }
});

// ── Alta de un registro puntual de horas extra ───────────────────────────
router.post('/agregar', async (req, res) => {
  const usuarioId = parseInt(req.body.usuario_id, 10);
  const fecha = (req.body.fecha || '').trim();
  const horas = parseFloat(req.body.horas);
  const nota = (req.body.nota || '').trim();
  const mesVolver = /^\d{4}-\d{2}$/.test(req.body.mes || '') ? req.body.mes : mesActualYYYYMM();

  if (!usuarioId || !/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !horas || horas <= 0 || horas > 24) {
    return res.redirect(`/horas-extra?mes=${mesVolver}&msg=${encodeURIComponent('Revisá los datos: falta el empleado, la fecha o la cantidad de horas no es válida.')}`);
  }

  try {
    // Solo empleados activos de cocina (mismo criterio que Miembro de
    // equipo) — evita cargar horas extra por error en la cuenta de alguien
    // de otro departamento, o en una cuenta de admin.
    const empleado = await db.get2(`SELECT id, nombre FROM usuarios WHERE id=$1 AND activo=1 AND departamento = ANY($2) AND ${NO_ADMIN}`, [usuarioId, SECTORES]);
    if (!empleado) {
      return res.redirect(`/horas-extra?mes=${mesVolver}&msg=${encodeURIComponent('Error: no encontré ese empleado activo de Cocina.')}`);
    }

    await db.run2(`
      INSERT INTO horas_extra (usuario_id, fecha, horas, nota, creado_por, creado_por_nombre)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [usuarioId, fecha, horas, nota || null, req.session.usuario.id, req.session.usuario.nombre]);

    const mesDelRegistro = fecha.slice(0, 7);
    res.redirect(`/horas-extra?mes=${mesDelRegistro}&msg=${encodeURIComponent(`Cargué ${horas}hs extra para ${empleado.nombre}.`)}`);
  } catch (e) {
    console.error('Error agregando horas extra:', e.message);
    res.redirect(`/horas-extra?mes=${mesVolver}&msg=${encodeURIComponent('Error al cargar las horas extra. Probá de nuevo.')}`);
  }
});

// ── Borrado de un registro (para corregir una carga mal hecha) ──────────
router.post('/:id/eliminar', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const mesVolver = /^\d{4}-\d{2}$/.test(req.body.mes || '') ? req.body.mes : mesActualYYYYMM();
  try {
    await db.run2(`DELETE FROM horas_extra WHERE id=$1`, [id]);
    res.redirect(`/horas-extra?mes=${mesVolver}&msg=${encodeURIComponent('Eliminé el registro.')}`);
  } catch (e) {
    console.error('Error eliminando horas extra:', e.message);
    res.redirect(`/horas-extra?mes=${mesVolver}&msg=${encodeURIComponent('Error al eliminar el registro. Probá de nuevo.')}`);
  }
});

module.exports = router;
