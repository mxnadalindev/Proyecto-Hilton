// estado_costeo_tragos.js — solo lectura, no cambia nada.
//
// Diagnóstico del módulo REAL de costeo de tragos (Costos → AYB), que usa
// las tablas platos_costo + plato_insumos_ayb + productos_ayb (no tiene
// nada que ver con "recetas"/"insumos", que es otro módulo aparte —
// disculpas por la confusión anterior).
//
// Además chequea algo importante: cuando limpiamos Inventario AYB
// (desactivando los productos que no eran del código 220 del Bar),
// también quedaron desactivados los ~141 productos de "Destilados" /
// "Otros insumos de barra" — y la pantalla para agregar ingredientes a un
// trago en Costos SOLO deja elegir productos ACTIVOS de productos_ayb. Este
// script chequea si eso rompió algo: si algún trago ya armado usa un
// producto que ahora está inactivo (el costo ya guardado no se pierde,
// pero no se podría volver a elegir ese ingrediente para un trago nuevo).

const db = require('./src/db/database');

(async () => {
  const tragos = await db.all2("SELECT id, nombre, categoria, costo_total FROM platos_costo WHERE departamento='ayb' ORDER BY nombre");

  const sinCosto = tragos.filter(t => !t.costo_total || parseFloat(t.costo_total) === 0);
  const conCosto = tragos.filter(t => t.costo_total && parseFloat(t.costo_total) > 0);

  console.log('====================================================');
  console.log('ESTADO DE COSTEO — Tragos (AYB)');
  console.log('====================================================');
  console.log(`Total de tragos cargados: ${tragos.length}`);
  console.log(`✔ Con costo_total > 0: ${conCosto.length}`);
  console.log(`✘ Con costo_total en $0 o vacío: ${sinCosto.length}`);
  console.log('');

  if (sinCosto.length) {
    console.log('--- Tragos con costo $0 (primeros 30) ---');
    sinCosto.slice(0, 30).forEach(t => console.log(`  #${t.id} ${t.nombre} | categoría: ${t.categoria || '-'}`));
    if (sinCosto.length > 30) console.log(`  ... y ${sinCosto.length - 30} más`);
    console.log('');
  }

  // Chequeo del posible efecto colateral de la desactivación masiva
  const productosInactivosUsados = await db.all2(`
    SELECT DISTINCT pr.id, pr.nombre, pr.categoria, COUNT(pi.id)::int AS usado_en_tragos
    FROM plato_insumos_ayb pi
    JOIN productos_ayb pr ON pr.id = pi.insumo_id
    WHERE pr.activo = false
    GROUP BY pr.id, pr.nombre, pr.categoria
    ORDER BY usado_en_tragos DESC
  `);
  console.log(`⚠ Ingredientes usados en algún trago que HOY están desactivados en Inventario AYB: ${productosInactivosUsados.length}`);
  if (productosInactivosUsados.length) {
    console.log('(el costo ya calculado de esos tragos sigue funcionando bien, pero si querés AGREGAR o CAMBIAR ese ingrediente en algún trago, hoy no aparecería en el listado para elegir, porque ese listado solo muestra productos activos)');
    productosInactivosUsados.slice(0, 30).forEach(p => console.log(`  #${p.id} ${p.nombre} | categoría: ${p.categoria || '-'} | usado en ${p.usado_en_tragos} trago(s)`));
    if (productosInactivosUsados.length > 30) console.log(`  ... y ${productosInactivosUsados.length - 30} más`);
  }

  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
