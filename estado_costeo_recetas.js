// estado_costeo_recetas.js
//
// Diagnóstico de solo lectura (no cambia nada) — muestra, para cada
// categoría/área de recetas cargada, cuántas tienen costo calculado y
// cuántas no, para poder identificar cuáles son "tragos" y qué les falta.
//
// El costo de una receta se calcula sumando (cantidad x precio_unitario del
// insumo) de cada ingrediente cargado (ver receta_insumos + insumos). Una
// receta puede dar $0 de costo por dos motivos distintos:
//   a) No tiene NINGÚN ingrediente cargado todavía.
//   b) Tiene ingredientes cargados, pero alguno de los insumos no tiene
//      precio_unitario cargado (o está en 0) en la tabla de insumos.
//
// Uso: node estado_costeo_recetas.js

const db = require('./src/db/database');

(async () => {
  const recetas = await db.all2('SELECT id, nombre, categoria, area FROM recetas ORDER BY categoria NULLS LAST, area NULLS LAST, nombre');

  const conCosto = [];
  const sinIngredientes = [];
  const conIngredientesSinPrecio = [];

  for (const r of recetas) {
    const ingredientes = await db.all2(`
      SELECT ri.cantidad, i.nombre, i.precio_unitario
      FROM receta_insumos ri JOIN insumos i ON i.id = ri.insumo_id
      WHERE ri.receta_id = $1`, [r.id]);

    if (ingredientes.length === 0) {
      sinIngredientes.push(r);
      continue;
    }

    const costo = ingredientes.reduce((acc, ing) => acc + (parseFloat(ing.cantidad) || 0) * (parseFloat(ing.precio_unitario) || 0), 0);
    const sinPrecio = ingredientes.filter(ing => !ing.precio_unitario || parseFloat(ing.precio_unitario) === 0);

    if (costo === 0 || sinPrecio.length > 0) {
      conIngredientesSinPrecio.push({ ...r, ingredientesSinPrecio: sinPrecio.map(i => i.nombre), costo });
    } else {
      conCosto.push({ ...r, costo });
    }
  }

  console.log('====================================================');
  console.log('ESTADO DE COSTEO — todas las recetas');
  console.log('====================================================');
  console.log(`Total de recetas: ${recetas.length}`);
  console.log(`✔ Costeadas correctamente (con ingredientes y precio): ${conCosto.length}`);
  console.log(`✘ Sin ningún ingrediente cargado: ${sinIngredientes.length}`);
  console.log(`⚠ Con ingredientes pero algún insumo sin precio (o costo $0): ${conIngredientesSinPrecio.length}`);
  console.log('');

  console.log('--- Recetas por categoría / área (para identificar cuáles son "tragos") ---');
  const grupos = {};
  recetas.forEach(r => {
    const clave = `${r.categoria || '(sin categoría)'} / ${r.area || '(sin área)'}`;
    grupos[clave] = (grupos[clave] || 0) + 1;
  });
  Object.entries(grupos).sort((a, b) => b[1] - a[1]).forEach(([clave, cant]) => console.log(`  ${clave}: ${cant}`));
  console.log('');

  if (sinIngredientes.length) {
    console.log(`--- Recetas SIN ningún ingrediente cargado (${sinIngredientes.length}) ---`);
    sinIngredientes.forEach(r => console.log(`  #${r.id} ${r.nombre} | ${r.categoria || '-'} / ${r.area || '-'}`));
    console.log('');
  }

  if (conIngredientesSinPrecio.length) {
    console.log(`--- Recetas con ingredientes pero SIN costo completo (${conIngredientesSinPrecio.length}) ---`);
    conIngredientesSinPrecio.forEach(r => console.log(`  #${r.id} ${r.nombre} | ${r.categoria || '-'} / ${r.area || '-'} | costo actual: $${r.costo.toFixed(2)} | insumos sin precio: ${r.ingredientesSinPrecio.join(', ') || '(ninguno, pero costo dio 0)'}`));
    console.log('');
  }

  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
