const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');

router.get('/', loginRequerido, async (req, res) => {
  const eventos = await db.all2(`
    SELECT e.*, u.nombre as creador FROM eventos e
    LEFT JOIN usuarios u ON e.creado_por = u.id
    ORDER BY e.fecha DESC
  `);
  res.render('eventos', { eventos });
});

router.get('/nuevo', loginRequerido, async (req, res) => {
  const personal = await db.all2("SELECT id,nombre,rol FROM usuarios WHERE activo=1 ORDER BY nombre");
  res.render('evento_nuevo', { personal });
});

router.post('/nuevo', loginRequerido, async (req, res) => {
  try {
    const { nombre, fecha, hora_inicio, hora_fin, descripcion, horas_produccion } = req.body;
    let platos=[], personalLista=[], vajilla=[];
    try { platos = JSON.parse(req.body.platos_json||'[]'); } catch(e){}
    try { personalLista = JSON.parse(req.body.personal_json||'[]'); } catch(e){}
    try { vajilla = JSON.parse(req.body.vajilla_json||'[]'); } catch(e){}
    const costo_total = platos.reduce((s,p) => s+(parseFloat(p.subtotal)||0), 0);

    const res2 = await db.get2(`
      INSERT INTO eventos (nombre,fecha,hora_inicio,hora_fin,descripcion,
        cantidad_personal,horas_produccion,costo_total,creado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [nombre, fecha, hora_inicio, hora_fin, descripcion,
        personalLista.length, parseFloat(horas_produccion)||0,
        costo_total, req.session.usuario.id]);

    const eventoId = res2.id;

    for (const p of platos) {
      await db.run2(
        "INSERT INTO evento_platos (evento_id,plato_nombre,cantidad_porciones,costo_porcion,subtotal) VALUES ($1,$2,$3,$4,$5)",
        [eventoId, p.nombre, parseInt(p.porciones)||1, parseFloat(p.costo)||0, parseFloat(p.subtotal)||0]
      );
    }
    for (const uid of personalLista) {
      await db.run2("INSERT INTO evento_personal (evento_id,usuario_id) VALUES ($1,$2)", [eventoId, parseInt(uid)]);
    }
    for (const v of vajilla) {
      await db.run2("INSERT INTO evento_vajilla (evento_id,vajilla_nombre,cantidad) VALUES ($1,$2,$3)", [eventoId, v.nombre, parseInt(v.cantidad)||1]);
    }
    res.redirect('/eventos');
  } catch(e) { console.error(e); res.redirect('/eventos'); }
});

router.get('/:id', loginRequerido, async (req, res) => {
  const evento = await db.get2(`SELECT e.*,u.nombre as creador FROM eventos e LEFT JOIN usuarios u ON e.creado_por=u.id WHERE e.id=$1`, [req.params.id]);
  if (!evento) return res.redirect('/eventos');
  const platos   = await db.all2("SELECT * FROM evento_platos WHERE evento_id=$1", [req.params.id]);
  const personal = await db.all2(`SELECT u.nombre,u.rol FROM evento_personal ep JOIN usuarios u ON ep.usuario_id=u.id WHERE ep.evento_id=$1`, [req.params.id]);
  const vajilla  = await db.all2("SELECT * FROM evento_vajilla WHERE evento_id=$1", [req.params.id]);
  res.render('evento_detalle', { evento, platos, personal, vajilla });
});

router.post('/:id/eliminar', loginRequerido, async (req, res) => {
  const id = req.params.id;
  await db.run2("DELETE FROM evento_platos WHERE evento_id=$1", [id]);
  await db.run2("DELETE FROM evento_personal WHERE evento_id=$1", [id]);
  await db.run2("DELETE FROM evento_vajilla WHERE evento_id=$1", [id]);
  await db.run2("DELETE FROM eventos WHERE id=$1", [id]);
  res.redirect('/eventos');
});

module.exports = router;
