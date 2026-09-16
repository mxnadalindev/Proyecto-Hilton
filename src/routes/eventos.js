const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido, requiereDepartamento } = require('./middleware');
const { calcularBocaditos, calcularPersonalRequerido } = require('../services/calculoBocaditos');
router.use(loginRequerido, requiereDepartamento('/eventos'));

// Trae el catálogo de bocaditos (fríos/calientes/principales/postres) que
// se usa en "Nuevo evento" en vez del viejo selector de platos de Costos.
async function getCatalogoBocaditos() {
  const filas = await db.all2('SELECT * FROM bocaditos_catalogo ORDER BY categoria, nombre');
  const agrupado = { frios: [], calientes: [], principales: [], postres: [] };
  for (const f of filas) {
    if (agrupado[f.categoria]) agrupado[f.categoria].push(f);
  }
  return agrupado;
}

// Trae todos los menús con sus platos ya cargados (para los selectores de "menú completo").
// Los platos de un menú salen del catálogo de Bocaditos de Eventos (no de Costos),
// igual que en "Nuevo evento".
async function getMenusConPlatos() {
  const menus = await db.all2("SELECT * FROM menus ORDER BY nombre");
  const resultado = [];
  for (const m of menus) {
    const platosDelMenu = await db.all2(`
      SELECT mp.id as menu_plato_id, mp.cantidad_porciones,
             p.id as plato_id, p.nombre, p.categoria, p.costo_unitario
      FROM menu_platos mp JOIN bocaditos_catalogo p ON mp.plato_id = p.id
      WHERE mp.menu_id = $1
      ORDER BY p.categoria, p.nombre
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
  const personal = await db.all2("SELECT id,nombre,rol FROM usuarios WHERE activo=1 ORDER BY nombre");
  const catalogoBocaditos = await getCatalogoBocaditos();
  res.render('evento_nuevo', { personal, catalogoBocaditos, path: 'eventos' });
});

router.post('/nuevo', loginRequerido, async (req, res) => {
  try {
    const { nombre, fecha, hora_inicio, hora_fin, descripcion, horas_produccion, prod_inicio, prod_fin, comensales } = req.body;
    let seleccionBocaditos=[], personalLista=[], vajillaExtra=[];
    try { seleccionBocaditos = JSON.parse(req.body.bocaditos_json ||'[]'); } catch(e){}
    try { personalLista      = JSON.parse(req.body.personal_json  ||'[]'); } catch(e){}
    try { vajillaExtra       = JSON.parse(req.body.vajilla_json   ||'[]'); } catch(e){}

    // El cálculo de bocados/vajilla se rehace acá en el servidor a partir
    // de la selección + comensales — nunca se confía en los números que
    // mande el navegador, así nadie puede mandar un bocados_totales
    // truchado por HTML/consola. La única fuente de verdad de la fórmula
    // es src/services/calculoBocaditos.js.
    //
    // El costo_unitario que venga del navegador tampoco se usa: se pisa acá
    // con el que está guardado en bocaditos_catalogo, para que nadie pueda
    // inflar o vaciar el costo total de un evento editando el HTML/consola.
    const pax = parseInt(comensales, 10) || 0;
    const idsSeleccionados = [...new Set(seleccionBocaditos.map(b => parseInt(b.id)).filter(n => Number.isInteger(n)))];
    let costosPorId = {};
    if (idsSeleccionados.length) {
      const filasCosto = await db.all2(
        `SELECT id, costo_unitario FROM bocaditos_catalogo WHERE id = ANY($1::int[])`,
        [idsSeleccionados]
      );
      filasCosto.forEach(f => { costosPorId[f.id] = parseFloat(f.costo_unitario) || 0; });
    }
    seleccionBocaditos = seleccionBocaditos.map(b => ({ ...b, costo_unitario: costosPorId[parseInt(b.id)] || 0 }));

    const bocaditosCalculados = calcularBocaditos(seleccionBocaditos, pax);
    const personalRequerido = calcularPersonalRequerido(pax);
    const costoBocaditosEvento = Math.round(bocaditosCalculados.reduce((acc, b) => acc + (b.costo_total || 0), 0) * 100) / 100;

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
        cantidad_personal,horas_produccion,costo_total,creado_por,
        comensales,personal_servicio_requerido,personal_produccion_requerido,
        costo_bocaditos)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id
    `, [nombre, fecha, hora_inicio||null, hora_fin||null, descripcion||null,
        personalLista.length, hs_prod, costoBocaditosEvento, req.session.usuario.id,
        pax || null, personalRequerido.servicio, personalRequerido.produccion,
        costoBocaditosEvento]);

    const eventoId = res2.id;

    for (const b of bocaditosCalculados) {
      await db.run2(
        `INSERT INTO evento_bocaditos (evento_id,bocadito_id,categoria,nombre,bocados_totales,vajilla_texto,vajilla_cantidad,costo_unitario,costo_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [eventoId, parseInt(b.id) || null, b.categoria, b.nombre, b.bocados_totales, b.vajilla_texto || null, b.vajilla_cantidad, b.costo_unitario || 0, b.costo_total || 0]
      );
      if (b.vajilla_texto && b.vajilla_cantidad > 0) {
        await db.run2("INSERT INTO evento_vajilla (evento_id,vajilla_nombre,cantidad) VALUES ($1,$2,$3)",
          [eventoId, `${b.vajilla_texto} — ${b.nombre}`, b.vajilla_cantidad]);
      }
    }
    for (const uid of personalLista) {
      await db.run2("INSERT INTO evento_personal (evento_id,usuario_id) VALUES ($1,$2)", [eventoId, parseInt(uid)]);
    }
    // Vajilla adicional cargada a mano (para cosas fuera del catálogo de
    // bocaditos, como cubiertos o servilleteros) — se suma aparte de la
    // vajilla calculada automáticamente arriba.
    for (const v of vajillaExtra) {
      await db.run2("INSERT INTO evento_vajilla (evento_id,vajilla_nombre,cantidad) VALUES ($1,$2,$3)",
        [eventoId, v.nombre, parseInt(v.cantidad)||1]);
    }
    res.redirect('/eventos/' + eventoId);
  } catch(e) {
    console.error('Error creando evento:', e);
    res.redirect('/eventos');
  }
});

// ── Costos del catálogo de bocaditos ────────────────────
// IMPORTANTE: van antes de "/:id" para que Express no confunda esta ruta con un id de evento.
// Acá se carga/edita el costo por bocado de cada plato del catálogo — el
// que se usa después para costear automáticamente cada evento nuevo.
router.get('/bocaditos-costos', loginRequerido, async (req, res) => {
  const catalogoBocaditos = await getCatalogoBocaditos();
  res.render('bocaditos_costos', { catalogoBocaditos, guardado: req.query.guardado, path: 'eventos' });
});

router.post('/bocaditos-costos', loginRequerido, async (req, res) => {
  try {
    // Nombres de campo "costo_<id>" (no "costo[<id>]"): con corchetes y un
    // número adentro, el parser de body (qs) los toma como índices de un
    // array en vez de como claves sueltas, y con muchos platos terminaba
    // pisando/mezclando valores de un plato con los de otro. Con el
    // guion bajo cada campo llega suelto y sin ambigüedad.
    for (const [campo, valor] of Object.entries(req.body)) {
      if (!campo.startsWith('costo_')) continue;
      const id = parseInt(campo.slice('costo_'.length), 10);
      if (!Number.isInteger(id)) continue;
      const num = parseFloat(String(valor).replace(',', '.'));
      await db.run2("UPDATE bocaditos_catalogo SET costo_unitario=$1 WHERE id=$2",
        [Number.isFinite(num) && num >= 0 ? num : 0, id]);
    }
    res.redirect('/eventos/bocaditos-costos?guardado=1');
  } catch (e) {
    console.error('Error guardando costos de bocaditos:', e.message);
    res.redirect('/eventos/bocaditos-costos');
  }
});

// ── Menús (grupos de platos reutilizables) ─────────────
// IMPORTANTE: estas rutas van antes de "/:id" para que Express no confunda "/menus" con un id de evento.

router.get('/menus', loginRequerido, async (req, res) => {
  const menus = await getMenusConPlatos();
  res.render('menus', { menus, path: 'eventos' });
});

router.get('/menus/nuevo', loginRequerido, async (req, res) => {
  const catalogoBocaditos = await getCatalogoBocaditos();
  res.render('menu_nuevo', { catalogoBocaditos, path: 'eventos' });
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
           p.id as plato_id, p.nombre, p.categoria, p.costo_unitario
    FROM menu_platos mp JOIN bocaditos_catalogo p ON mp.plato_id = p.id
    WHERE mp.menu_id = $1
    ORDER BY p.categoria, p.nombre
  `, [req.params.id]);
  const catalogoBocaditos = await getCatalogoBocaditos();
  res.render('menu_detalle', { menu, platosDelMenu, catalogoBocaditos, path: 'eventos' });
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
  const platos     = await db.all2("SELECT * FROM evento_platos WHERE evento_id=$1",  [req.params.id]);
  const bocaditos  = await db.all2("SELECT * FROM evento_bocaditos WHERE evento_id=$1 ORDER BY categoria, nombre", [req.params.id]);
  const personal = await db.all2(`SELECT u.nombre,u.rol FROM evento_personal ep JOIN usuarios u ON ep.usuario_id=u.id WHERE ep.evento_id=$1`, [req.params.id]);
  const vajilla  = await db.all2("SELECT * FROM evento_vajilla WHERE evento_id=$1", [req.params.id]);
  // platosConCosto (base de Costos) y menus ya no se usan acá: evento_detalle.ejs
  // solo muestra Bocaditos desde que se sacó la sección "Platos del menú".
  res.render('evento_detalle', { evento, platos, bocaditos, personal, vajilla, path: 'eventos' });
});

// Orden de evento (BEO) — versión imprimible/PDF de un evento, con todo lo
// que hace falta en cocina: menú y cantidades, vajilla, personal, costo.
// Usa exactamente los mismos datos que la pantalla de detalle; es solo
// otra forma de mostrarlos, pensada para imprimir o mandar por WhatsApp
// como PDF (con "Guardar como PDF" del navegador al imprimir).
router.get('/:id/beo', loginRequerido, async (req, res) => {
  const evento  = await db.get2(`SELECT e.*,u.nombre as creador FROM eventos e LEFT JOIN usuarios u ON e.creado_por=u.id WHERE e.id=$1`, [req.params.id]);
  if (!evento) return res.redirect('/eventos');
  const platos    = await db.all2("SELECT * FROM evento_platos WHERE evento_id=$1", [req.params.id]);
  const bocaditos = await db.all2("SELECT * FROM evento_bocaditos WHERE evento_id=$1 ORDER BY categoria, nombre", [req.params.id]);
  const personal  = await db.all2(`SELECT u.nombre,u.rol FROM evento_personal ep JOIN usuarios u ON ep.usuario_id=u.id WHERE ep.evento_id=$1 ORDER BY u.nombre`, [req.params.id]);
  const vajilla   = await db.all2("SELECT * FROM evento_vajilla WHERE evento_id=$1 ORDER BY vajilla_nombre", [req.params.id]);
  res.render('evento_beo', { evento, platos, bocaditos, personal, vajilla, path: 'eventos' });
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
  const totalPlatos = items.reduce((s, i) => s + (parseFloat(i.subtotal) || 0), 0);
  // costo_bocaditos se calcula una sola vez al crear el evento (ver POST
  // /nuevo) y no se toca acá — evento_total = platos (editables desde el
  // detalle) + bocaditos (fijos desde la creación del evento).
  const eventoRow = await db.get2("SELECT costo_bocaditos FROM eventos WHERE id=$1", [evento_id]);
  const totalBocaditos = parseFloat(eventoRow && eventoRow.costo_bocaditos) || 0;
  await db.run2("UPDATE eventos SET costo_total=$1 WHERE id=$2", [totalPlatos + totalBocaditos, evento_id]);
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
