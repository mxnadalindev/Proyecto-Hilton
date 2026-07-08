const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');

// Trae todos los menús con sus platos ya cargados (para los selectores de "menú completo")
async function getMenusConPlatos() {
  const menus = await db.all2("SELECT * FROM menus ORDER BY nombre");
  const resultado = [];
  for (const m of menus) {
    const platosDelMenu = await db.all2(`
      SELECT mp.id as menu_plato_id, mp.cantidad_porciones,
             p.id as plato_id, p.nombre, p.costo_total, p.porciones as porciones_base
      FROM menu_platos mp JOIN platos_costo p ON mp.plato_id = p.id
      WHERE mp.menu_id = $1
      ORDER BY p.nombre
    `, [m.id]);
    resultado.push({ ...m, platos: platosDelMenu });
  }
  return resultado;
}

router.get('/', loginRequerido, async (req, res) => {
  const eventos = await db.all2(`
    SELECT e.*, u.nombre as creador FROM eventos e
    LEFT JOIN usuarios u ON e.creado_por = u.id
    ORDER BY e.fecha DESC
  `);
  res.render('eventos', { eventos, path: 'eventos' });
});

router.get('/nuevo', loginRequerido, async (req, res) => {
  const personal       = await db.all2("SELECT id,nombre,rol FROM usuarios WHERE activo=1 ORDER BY nombre");
  const recetas        = await db.all2("SELECT id,nombre FROM recetas ORDER BY nombre");
  const platosConCosto = await db.all2("SELECT id,nombre,costo_total,porciones FROM platos_costo WHERE costo_total>0 ORDER BY nombre");
  const menus           = await getMenusConPlatos();
  res.render('evento_nuevo', { personal, recetas, platosConCosto, menus, path: 'eventos' });
});

router.post('/nuevo', loginRequerido, async (req, res) => {
  try {
    const { nombre, fecha, hora_inicio, hora_fin, descripcion, horas_produccion, prod_inicio, prod_fin } = req.body;
    let platos=[], personalLista=[], vajilla=[];
    try { platos       = JSON.parse(req.body.platos_json   ||'[]'); } catch(e){}
    try { personalLista= JSON.parse(req.body.personal_json ||'[]'); } catch(e){}
    try { vajilla      = JSON.parse(req.body.vajilla_json  ||'[]'); } catch(e){}

    const costo_total = platos.reduce((s,p) => s+(parseFloat(p.subtotal)||0), 0);

    let hs_prod = parseFloat(horas_produccion) || 0;
    if (prod_inicio && prod_fin && !hs_prod) {
      const [h1,m1] = prod_inicio.split(':').map(Number);
      const [h2,m2] = prod_fin.split(':').map(Number);
      let mins = (h2*60+m2)-(h1*60+m1);
      if (mins < 0) mins += 24*60;
      hs_prod = parseFloat((mins/60).toFixed(1));
    }

    const res2 = await db.get2(`
      INSERT INTO eventos (nombre,fecha,hora_inicio,hora_fin,descripcion,
        cantidad_personal,horas_produccion,costo_total,creado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [nombre, fecha, hora_inicio||null, hora_fin||null, descripcion||null,
        personalLista.length, hs_prod, costo_total, req.session.usuario.id]);

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
      await db.run2("INSERT INTO evento_vajilla (evento_id,vajilla_nombre,cantidad) VALUES ($1,$2,$3)",
        [eventoId, v.nombre, parseInt(v.cantidad)||1]);
    }
    res.redirect('/eventos');
  } catch(e) {
    console.error('Error creando evento:', e);
    res.redirect('/eventos');
  }
});

// ── Menús (grupos de platos reutilizables) ─────────────
// IMPORTANTE: estas rutas van antes de "/:id" para que Express no confunda "/menus" con un id de evento.

router.get('/menus', loginRequerido, async (req, res) => {
  const menus = await getMenusConPlatos();
  res.render('menus', { menus, path: 'eventos' });
});

router.get('/menus/nuevo', loginRequerido, async (req, res) => {
  const platosConCosto = await db.all2("SELECT id,nombre,costo_total,porciones FROM platos_costo WHERE costo_total>0 ORDER BY nombre");
  res.render('menu_nuevo', { platosConCosto, path: 'eventos' });
});

router.post('/menus/nuevo', loginRequerido, async (req, res) => {
  try {
    const { nombre, descripcion } = req.body;
    let platoIds = req.body.platos || [];
    if (!Array.isArray(platoIds)) platoIds = [platoIds];

    const menu = await db.get2(
      "INSERT INTO menus (nombre, descripcion) VALUES ($1,$2) RETURNING id",
      [nombre, descripcion || null]
    );
    for (const pid of platoIds) {
      await db.run2("INSERT INTO menu_platos (menu_id, plato_id) VALUES ($1,$2)", [menu.id, parseInt(pid)]);
    }
    res.redirect('/eventos/menus/' + menu.id);
  } catch (e) {
    console.error('Error creando menú:', e.message);
    res.redirect('/eventos/menus');
  }
});

router.get('/menus/:id', loginRequerido, async (req, res) => {
  const menu = await db.get2("SELECT * FROM menus WHERE id=$1", [req.params.id]);
  if (!menu) return res.redirect('/eventos/menus');
  const platosDelMenu = await db.all2(`
    SELECT mp.id as menu_plato_id, mp.cantidad_porciones,
           p.id as plato_id, p.nombre, p.costo_total, p.porciones as porciones_base
    FROM menu_platos mp JOIN platos_costo p ON mp.plato_id = p.id
    WHERE mp.menu_id = $1
    ORDER BY p.nombre
  `, [req.params.id]);
  const todosPlatos = await db.all2("SELECT id,nombre,costo_total,porciones FROM platos_costo WHERE costo_total>0 ORDER BY nombre");
  res.render('menu_detalle', { menu, platosDelMenu, todosPlatos, path: 'eventos' });
});

router.post('/menus/:id/plato', loginRequerido, async (req, res) => {
  try {
    const { plato_id } = req.body;
    if (plato_id) {
      const yaExiste = await db.get2(
        "SELECT id FROM menu_platos WHERE menu_id=$1 AND plato_id=$2",
        [req.params.id, plato_id]
      );
      if (!yaExiste) {
        await db.run2("INSERT INTO menu_platos (menu_id, plato_id) VALUES ($1,$2)", [req.params.id, parseInt(plato_id)]);
      }
    }
  } catch (e) {
    console.error('Error agregando plato al menú:', e.message);
  }
  res.redirect('/eventos/menus/' + req.params.id);
});

router.post('/menus/:menu_id/plato/:id/eliminar', loginRequerido, async (req, res) => {
  await db.run2("DELETE FROM menu_platos WHERE id=$1", [req.params.id]);
  res.redirect('/eventos/menus/' + req.params.menu_id);
});

router.post('/menus/:id/eliminar', loginRequerido, async (req, res) => {
  await db.run2("DELETE FROM menu_platos WHERE menu_id=$1", [req.params.id]);
  await db.run2("DELETE FROM menus WHERE id=$1", [req.params.id]);
  res.redirect('/eventos/menus');
});

// ── Detalle de un evento ────────────────────────────────

router.get('/:id', loginRequerido, async (req, res) => {
  const evento  = await db.get2(`SELECT e.*,u.nombre as creador FROM eventos e LEFT JOIN usuarios u ON e.creado_por=u.id WHERE e.id=$1`, [req.params.id]);
  if (!evento) return res.redirect('/eventos');
  const platos   = await db.all2("SELECT * FROM evento_platos WHERE evento_id=$1",  [req.params.id]);
  const personal = await db.all2(`SELECT u.nombre,u.rol FROM evento_personal ep JOIN usuarios u ON ep.usuario_id=u.id WHERE ep.evento_id=$1`, [req.params.id]);
  const vajilla  = await db.all2("SELECT * FROM evento_vajilla WHERE evento_id=$1", [req.params.id]);
  const platosConCosto = await db.all2("SELECT id,nombre,costo_total,porciones FROM platos_costo WHERE costo_total>0 ORDER BY nombre");
  const menus           = await getMenusConPlatos();
  res.render('evento_detalle', { evento, platos, personal, vajilla, platosConCosto, menus, path: 'eventos' });
});

// Agrega un plato al menú de un evento ya creado (elegido de Costos o cargado a mano)
router.post('/:id/plato', loginRequerido, async (req, res) => {
  try {
    const { plato_nombre, cantidad_porciones, costo_porcion } = req.body;
    const porciones = parseInt(cantidad_porciones) || 1;
    const costo = parseFloat(costo_porcion) || 0;
    const subtotal = porciones * costo;

    await db.run2(
      "INSERT INTO evento_platos (evento_id,plato_nombre,cantidad_porciones,costo_porcion,subtotal) VALUES ($1,$2,$3,$4,$5)",
      [req.params.id, plato_nombre, porciones, costo, subtotal]
    );
    await recalcularCostoEvento(req.params.id);
  } catch (e) {
    console.error('Error agregando plato al evento:', e.message);
  }
  res.redirect('/eventos/' + req.params.id);
});

// Agrega TODOS los platos de un menú de una sola vez a un evento ya creado
router.post('/:id/menu', loginRequerido, async (req, res) => {
  try {
    const { menu_id } = req.body;
    const platosDelMenu = await db.all2(`
      SELECT p.nombre, p.costo_total, p.porciones, mp.cantidad_porciones
      FROM menu_platos mp JOIN platos_costo p ON mp.plato_id = p.id
      WHERE mp.menu_id = $1
    `, [menu_id]);

    for (const p of platosDelMenu) {
      const porcionesBase = p.porciones || 1;
      const porciones = p.cantidad_porciones || porcionesBase;
      const costoPorcion = parseFloat(p.costo_total) / porcionesBase;
      const subtotal = porciones * costoPorcion;
      await db.run2(
        "INSERT INTO evento_platos (evento_id,plato_nombre,cantidad_porciones,costo_porcion,subtotal) VALUES ($1,$2,$3,$4,$5)",
        [req.params.id, p.nombre, porciones, costoPorcion, subtotal]
      );
    }
    await recalcularCostoEvento(req.params.id);
  } catch (e) {
    console.error('Error agregando menú al evento:', e.message);
  }
  res.redirect('/eventos/' + req.params.id);
});

// Quita un plato del menú de un evento ya creado
router.post('/:evento_id/plato/:id/eliminar', loginRequerido, async (req, res) => {
  try {
    await db.run2("DELETE FROM evento_platos WHERE id=$1", [req.params.id]);
    await recalcularCostoEvento(req.params.evento_id);
  } catch (e) {
    console.error('Error quitando plato del evento:', e.message);
  }
  res.redirect('/eventos/' + req.params.evento_id);
});

async function recalcularCostoEvento(evento_id) {
  const items = await db.all2("SELECT subtotal FROM evento_platos WHERE evento_id=$1", [evento_id]);
  const total = items.reduce((s, i) => s + (parseFloat(i.subtotal) || 0), 0);
  await db.run2("UPDATE eventos SET costo_total=$1 WHERE id=$2", [total, evento_id]);
}

router.post('/:id/eliminar', loginRequerido, async (req, res) => {
  const id = req.params.id;
  await db.run2("DELETE FROM evento_platos   WHERE evento_id=$1", [id]);
  await db.run2("DELETE FROM evento_personal WHERE evento_id=$1", [id]);
  await db.run2("DELETE FROM evento_vajilla  WHERE evento_id=$1", [id]);
  await db.run2("DELETE FROM eventos WHERE id=$1", [id]);
  res.redirect('/eventos');
});

module.exports = router;
