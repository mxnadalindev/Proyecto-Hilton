// src/routes/eventos.js
const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');

router.get('/', loginRequerido, (req, res) => {
  const eventos = db.prepare(`
    SELECT e.*, u.nombre as creador
    FROM eventos e
    LEFT JOIN usuarios u ON e.creado_por = u.id
    ORDER BY e.fecha DESC
  `).all();
  res.render('eventos', { eventos });
});

router.get('/nuevo', loginRequerido, (req, res) => {
  const personal = db.prepare("SELECT id, nombre, rol FROM usuarios WHERE activo = 1 ORDER BY nombre").all();
  res.render('evento_nuevo', { personal });
});

router.post('/nuevo', loginRequerido, (req, res) => {
  const { nombre, fecha, hora_inicio, hora_fin, descripcion, horas_produccion } = req.body;
  let platos = [], personalLista = [], vajilla = [];
  try { platos = JSON.parse(req.body.platos_json || '[]'); } catch(e) {}
  try { personalLista = JSON.parse(req.body.personal_json || '[]'); } catch(e) {}
  try { vajilla = JSON.parse(req.body.vajilla_json || '[]'); } catch(e) {}

  const costo_total = platos.reduce((s, p) => s + (parseFloat(p.subtotal) || 0), 0);

  const info = db.prepare(`
    INSERT INTO eventos (nombre, fecha, hora_inicio, hora_fin, descripcion,
      cantidad_personal, horas_produccion, costo_total, creado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nombre, fecha, hora_inicio, hora_fin, descripcion,
         personalLista.length, parseFloat(horas_produccion) || 0,
         costo_total, req.session.usuario.id);

  const eventoId = info.lastInsertRowid;

  const insertPlato = db.prepare(`
    INSERT INTO evento_platos (evento_id, plato_nombre, cantidad_porciones, costo_porcion, subtotal)
    VALUES (?, ?, ?, ?, ?)
  `);
  platos.forEach(p => insertPlato.run(eventoId, p.nombre,
    parseInt(p.porciones) || 1, parseFloat(p.costo) || 0, parseFloat(p.subtotal) || 0));

  const insertPersonal = db.prepare("INSERT INTO evento_personal (evento_id, usuario_id) VALUES (?, ?)");
  personalLista.forEach(uid => insertPersonal.run(eventoId, parseInt(uid)));

  const insertVajilla = db.prepare("INSERT INTO evento_vajilla (evento_id, vajilla_nombre, cantidad) VALUES (?, ?, ?)");
  vajilla.forEach(v => insertVajilla.run(eventoId, v.nombre, parseInt(v.cantidad) || 1));

  res.redirect('/eventos');
});

router.get('/:id', loginRequerido, (req, res) => {
  const evento = db.prepare(`
    SELECT e.*, u.nombre as creador FROM eventos e
    LEFT JOIN usuarios u ON e.creado_por = u.id
    WHERE e.id = ?
  `).get(req.params.id);
  if (!evento) return res.redirect('/eventos');

  const platos   = db.prepare("SELECT * FROM evento_platos WHERE evento_id = ?").all(req.params.id);
  const personal = db.prepare(`
    SELECT u.nombre, u.rol FROM evento_personal ep
    JOIN usuarios u ON ep.usuario_id = u.id WHERE ep.evento_id = ?
  `).all(req.params.id);
  const vajilla  = db.prepare("SELECT * FROM evento_vajilla WHERE evento_id = ?").all(req.params.id);

  res.render('evento_detalle', { evento, platos, personal, vajilla });
});

router.post('/:id/eliminar', loginRequerido, (req, res) => {
  const id = req.params.id;
  db.prepare("DELETE FROM evento_platos WHERE evento_id = ?").run(id);
  db.prepare("DELETE FROM evento_personal WHERE evento_id = ?").run(id);
  db.prepare("DELETE FROM evento_vajilla WHERE evento_id = ?").run(id);
  db.prepare("DELETE FROM eventos WHERE id = ?").run(id);
  res.redirect('/eventos');
});

module.exports = router;
