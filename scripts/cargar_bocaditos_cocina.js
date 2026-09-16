// scripts/cargar_bocaditos_cocina.js — Carga el catálogo de 78 bocaditos
// (fríos/calientes/principales/postres, con su vajilla) que reemplaza al
// selector de platos de Costos en "Eventos → Nuevo evento" de Cocina.
//
// Se corre UNA sola vez (idempotente: si el catálogo ya tiene datos, no
// hace nada — así reinstalar el parche no duplica filas). No toca ninguna
// otra tabla: no borra platos_costo, menus ni eventos ya creados.
//
// Uso: node scripts/cargar_bocaditos_cocina.js
const path = require('path');
const datos = require('./bocaditos_cocina_datos.json');
const db = require('../src/db/database');

async function main() {
  await db.listaParaUsar;

  const yaCargado = await db.get2('SELECT COUNT(*)::int AS total FROM bocaditos_catalogo');
  if (yaCargado && yaCargado.total > 0) {
    console.log(`El catálogo de bocaditos ya tiene ${yaCargado.total} platos cargados — no se vuelve a cargar.`);
    console.log('(Si necesitás recargarlo desde cero, primero hay que vaciar la tabla bocaditos_catalogo a mano.)');
    process.exit(0);
  }

  let creados = 0;
  for (const item of datos) {
    await db.run2(
      'INSERT INTO bocaditos_catalogo (categoria, nombre, vajilla_texto, vajilla_capacidad) VALUES ($1,$2,$3,$4)',
      [item.categoria, item.nombre, item.vajilla_texto || null, item.vajilla_capacidad || 1]
    );
    creados++;
  }

  console.log(`Catálogo de bocaditos cargado: ${creados} platos.`);
  const porCategoria = {};
  for (const item of datos) porCategoria[item.categoria] = (porCategoria[item.categoria] || 0) + 1;
  console.log('Por categoría:', porCategoria);
  process.exit(0);
}

main().catch(e => { console.error('Error cargando el catálogo de bocaditos:', e); process.exit(1); });
