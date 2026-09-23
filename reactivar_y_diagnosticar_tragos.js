// reactivar_y_diagnosticar_tragos.js
//
// Dos cosas:
//
// 1) REACTIVA (activo = true) los productos de Inventario AYB que hoy están
//    desactivados pero se usan como ingrediente en algún trago de Costos.
//    Antes los habíamos desactivado a todos los que no eran del código 220
//    del Bar, pero varios de esos SÍ hacen falta (los ingredientes de
//    cóctel de "Destilados"/"Otros insumos de barra", y hasta algún
//    ingrediente de cocina como el azúcar). Sin esto, no se pueden agregar
//    ni cambiar esos ingredientes en ningún trago, porque el selector de
//    ingredientes de Costos solo muestra productos activos.
//    Esto NO reactiva los 141 completos, sólo los que están en uso — el
//    resto sigue como estaba, para no deshacer la limpieza sin necesidad.
//
// 2) Muestra el detalle completo de los tragos que hoy dan costo $0 (sus
//    ingredientes, cantidades y precios), para saber exactamente qué les
//    falta.
//
// Uso:
//   1) Modo prueba (no cambia nada):   node reactivar_y_diagnosticar_tragos.js
//   2) Si el reporte se ve bien:       node reactivar_y_diagnosticar_tragos.js --ejecutar

const db = require('./src/db/database');
const ejecutar = process.argv.includes('--ejecutar');

(async () => {
  // ── Parte 1: reactivar ingredientes en uso ──────────────────────
  const usados = await db.all2(`
    SELECT DISTINCT pr.id, pr.nombre, pr.categoria
    FROM plato_insumos_ayb pi
    JOIN productos_ayb pr ON pr.id = pi.insumo_id
    WHERE pr.activo = false
    ORDER BY pr.categoria, pr.nombre
  `);

  console.log('====================================================');
  console.log('PARTE 1 — Reactivar ingredientes en uso en tragos');
  console.log('====================================================');
  console.log(`Productos a reactivar: ${usados.length}`);
  usados.forEach(p => console.log(`  #${p.id} ${p.nombre} | ${p.categoria || '-'}`));
  console.log('');

  if (ejecutar && usados.length) {
    const ids = usados.map(p => p.id);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    await db.run2(`UPDATE productos_ayb SET activo = true WHERE id IN (${placeholders})`, ids);
    console.log(`✔ Reactivados ${usados.length} productos.`);
  } else if (!ejecutar) {
    console.log('(modo prueba — todavía no se reactivó nada)');
  }
  console.log('');

  // ── Parte 2: detalle de los tragos en $0 (solo lectura) ─────────
  console.log('====================================================');
  console.log('PARTE 2 — Detalle de los tragos con costo $0');
  console.log('====================================================');
  const tragosCero = await db.all2("SELECT id, nombre FROM platos_costo WHERE departamento='ayb' AND (costo_total IS NULL OR costo_total = 0) ORDER BY nombre");

  for (const t of tragosCero) {
    const ingredientes = await db.all2(`
      SELECT pi.cantidad, pi.unidad, pr.nombre, pr.precio_unitario, pr.activo
      FROM plato_insumos_ayb pi JOIN productos_ayb pr ON pr.id = pi.insumo_id
      WHERE pi.plato_id = $1`, [t.id]);
    console.log(`--- #${t.id} ${t.nombre} (${ingredientes.length} ingrediente(s)) ---`);
    if (ingredientes.length === 0) {
      console.log('  (no tiene NINGÚN ingrediente cargado)');
    } else {
      ingredientes.forEach(i => console.log(`  ${i.nombre} | cantidad: ${i.cantidad}${i.unidad || ''} | precio_unitario: ${i.precio_unitario ?? '(sin precio)'} | ${i.activo ? 'activo' : 'INACTIVO'}`));
    }
  }

  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
