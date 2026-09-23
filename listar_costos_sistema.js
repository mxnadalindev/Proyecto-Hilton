// listar_costos_sistema.js
//
// Script de solo lectura (no cambia nada en la base de datos).
// Imprime, para cada trago de AYB cargado en Costos, todos sus ingredientes
// con cantidad, precio unitario y costo parcial, y el costo total del trago.
//
// Lo uso para comparar, ingrediente por ingrediente, lo que hoy tiene
// cargado el sistema contra el Excel que me pasaste — así detecto exactamente
// dónde difieren (¿ingrediente distinto? ¿cantidad distinta? ¿precio distinto?)
// en vez de adivinar trago por trago.
//
// Uso:
//   node listar_costos_sistema.js
//
// Te va a tirar un bloque de texto largo — copialo TODO (desde la primera
// línea "===" hasta la última) y pegámelo en el chat.

const db = require('./src/db/database');

(async () => {
  const platos = await db.all2(
    "SELECT id, nombre, costo_total, departamento FROM platos_costo WHERE departamento='ayb' ORDER BY nombre"
  );

  console.log('====================================================');
  console.log(`LISTADO DE COSTOS — AYB (${platos.length} trago(s))`);
  console.log('====================================================');

  for (const p of platos) {
    console.log('');
    console.log(`### ${p.nombre} (id ${p.id}) — costo_total: ${p.costo_total}`);
    const insumos = await db.all2(
      `SELECT pi.cantidad, pi.unidad, pi.costo_parcial, pr.nombre AS ingrediente, pr.precio_unitario
       FROM plato_insumos_ayb pi
       JOIN productos_ayb pr ON pr.id = pi.insumo_id
       WHERE pi.plato_id = $1
       ORDER BY pi.id`,
      [p.id]
    );
    if (insumos.length === 0) {
      console.log('  (sin ingredientes cargados)');
    }
    insumos.forEach((i) => {
      console.log(
        `  - ${i.ingrediente} | cantidad: ${i.cantidad}${i.unidad || ''} | precio_unitario: ${i.precio_unitario} | costo_parcial: ${i.costo_parcial}`
      );
    });
  }

  console.log('');
  console.log('====================================================');
  console.log('FIN DEL LISTADO');
  console.log('====================================================');
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
