// recalcular_todos_costos_ayb.js
//
// Por qué hace falta esto: el "costo parcial" de cada ingrediente en un trago
// (plato_insumos_ayb.costo_parcial) se GUARDA en el momento en que cargás o
// editás esa línea de receta — no se recalcula solo cuando el precio del
// ingrediente cambia después. Como en esta sesión fuimos actualizando precios
// de a poco (destilados, botellas por código, cervezas/gaseosas), quedaron
// varias líneas de recetas con el costo parcial viejo, de antes de esas
// actualizaciones, aunque el precio del producto ya esté al día.
//
// Este script recorre TODOS los tragos de AYB, recalcula el costo_parcial de
// cada ingrediente (cantidad × precio_unitario actual del producto) y el
// costo_total del trago, y te muestra qué cambió. No toca nombres, recetas
// ni cantidades — sólo refresca los números derivados de precios.
//
// Uso:
//   1) Modo prueba (no cambia nada):
//        node recalcular_todos_costos_ayb.js
//   2) Si el reporte se ve bien:
//        node recalcular_todos_costos_ayb.js --ejecutar

const db = require('./src/db/database');
const ejecutar = process.argv.includes('--ejecutar');

(async () => {
  const platos = await db.all2(
    "SELECT id, nombre, costo_total FROM platos_costo WHERE departamento='ayb' ORDER BY nombre"
  );

  console.log('====================================================');
  console.log(`RECALCULAR COSTOS — AYB (${platos.length} trago(s))`);
  console.log('====================================================');

  let platosConCambios = 0;
  let lineasConCambios = 0;

  for (const p of platos) {
    const insumos = await db.all2(
      `SELECT pi.id, pi.cantidad, pi.costo_parcial, pr.nombre AS ingrediente, pr.precio_unitario
       FROM plato_insumos_ayb pi
       JOIN productos_ayb pr ON pr.id = pi.insumo_id
       WHERE pi.plato_id = $1
       ORDER BY pi.id`,
      [p.id]
    );

    let nuevoTotal = 0;
    let cambiosEnEsteTrago = [];
    for (const i of insumos) {
      const nuevoParcial = i.cantidad * parseFloat(i.precio_unitario || 0);
      nuevoTotal += nuevoParcial;
      const diff = nuevoParcial - parseFloat(i.costo_parcial || 0);
      if (Math.abs(diff) > 0.01) {
        cambiosEnEsteTrago.push({ id: i.id, ingrediente: i.ingrediente, antes: i.costo_parcial, despues: nuevoParcial });
      }
    }

    const diffTotal = nuevoTotal - parseFloat(p.costo_total || 0);
    if (cambiosEnEsteTrago.length > 0 || Math.abs(diffTotal) > 0.01) {
      platosConCambios++;
      console.log('');
      console.log(`### ${p.nombre} — costo_total actual: ${p.costo_total} → nuevo: ${nuevoTotal.toFixed(2)}`);
      cambiosEnEsteTrago.forEach((c) => {
        lineasConCambios++;
        console.log(`  - ${c.ingrediente}: costo_parcial ${parseFloat(c.antes).toFixed(2)} → ${c.despues.toFixed(2)}`);
      });

      if (ejecutar) {
        for (const c of cambiosEnEsteTrago) {
          await db.run2('UPDATE plato_insumos_ayb SET costo_parcial=$1 WHERE id=$2', [c.despues, c.id]);
        }
        await db.run2('UPDATE platos_costo SET costo_total=$1 WHERE id=$2', [nuevoTotal, p.id]);
      }
    }
  }

  console.log('');
  console.log('====================================================');
  if (!ejecutar) {
    console.log(`MODO PRUEBA — no se cambió nada todavía.`);
    console.log(`Tragos con costos desactualizados: ${platosConCambios} | Líneas de ingredientes a corregir: ${lineasConCambios}`);
    console.log('Si el reporte se ve bien, correr de nuevo así:');
    console.log('  node recalcular_todos_costos_ayb.js --ejecutar');
  } else {
    console.log(`✔ Recalculados ${platosConCambios} trago(s), ${lineasConCambios} línea(s) de ingredientes corregidas.`);
    console.log('Listo.');
  }
  console.log('====================================================');
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
