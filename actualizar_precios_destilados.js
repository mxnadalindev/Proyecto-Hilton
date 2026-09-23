// actualizar_precios_destilados.js
//
// Actualiza el precio de los productos de Inventario AYB (Destilados /
// Aperitivos) usando la lista real de precios de botella que pasó Maxi
// (planilla "Destilados Aperitivos", Septiembre 2026).
//
// El sistema guarda el precio de cada producto en pesos POR ML (no por
// botella) — así lo usa la pantalla de Costos para calcular el costo de
// cada trago. Por eso este script convierte: precio_por_ml = precio de
// botella / tamaño de botella en ml.
//
// Seguridad: por defecto, SOLO actualiza productos que hoy tienen precio
// en $0 o sin precio cargado — no pisa precios que ya tenés cargados,
// aunque sean distintos a los de esta planilla (por las dudas sean más
// nuevos o los hayas ajustado vos). Si querés forzar la actualización de
// TODOS los que matcheen (incluso los que ya tienen un precio distinto),
// usá también el flag --forzar-todos junto con --ejecutar.
//
// Uso:
//   1) Modo prueba (no cambia nada):
//        node actualizar_precios_destilados.js
//   2) Si el reporte se ve bien (sólo actualiza los que están en $0):
//        node actualizar_precios_destilados.js --ejecutar
//   3) Para además actualizar los que ya tienen un precio distinto:
//        node actualizar_precios_destilados.js --ejecutar --forzar-todos

const db = require('./src/db/database');
const ejecutar = process.argv.includes('--ejecutar');
const forzarTodos = process.argv.includes('--forzar-todos');

// Países/regiones de origen que suelen aparecer al final del nombre
// ("Campari – Italia", "Cointreau - Francia") — se excluyen del matching
// porque por sí solas no dicen nada del producto y generan falsos
// positivos entre productos distintos del mismo país.
const PALABRAS_IGNORADAS = new Set([
  'italia','francia','inglaterra','escocia','irlanda','alemania',
  'argentina','cuba','mexico','jamaica','polonia','suecia','rusia',
  'espana','barbados','guatemala','sudafrica','holanda','peru',
  'colombia','chile','brasil','portugal','japon','china','india',
  'generico','generica',
]);
function normalizarTexto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(p => p.length > 1 && !PALABRAS_IGNORADAS.has(p));
}
function evaluarMatch(buscado, candidato) {
  const pa = normalizarTexto(buscado);
  const pb = normalizarTexto(candidato);
  const pbSet = new Set(pb);
  if (!pa.length || !pbSet.size) return { score: 0, precision: 0 };
  const comunes = pa.filter(p => pbSet.has(p)).length;
  if (comunes === 0) return { score: 0, precision: 0 };
  const precision = comunes / pb.length;
  if (comunes === 1 && pa.length >= 2 && precision < 0.34) return { score: 0, precision: 0 };
  return { score: comunes / pa.length, precision };
}
function mejorMatch(buscado, productos) {
  let mejor = null;
  for (const p of productos) {
    const { score, precision } = evaluarMatch(buscado, p.nombre);
    if (score < 0.5) continue;
    if (!mejor || score > mejor.score || (score === mejor.score && precision > mejor.precision)) {
      mejor = { ...p, score, precision };
    }
  }
  return mejor;
}

// ── Lista de precios reales (planilla "Destilados Aperitivos", Sept 2026) ──
const PRECIOS = [
  {
    "nombre": "Antica Formula – Italia",
    "bottleMl": 1000,
    "bottleCost": 43000
  },
  {
    "nombre": "Aperol - Italia",
    "bottleMl": 750,
    "bottleCost": 6932
  },
  {
    "nombre": "Campari – Italia",
    "bottleMl": 750,
    "bottleCost": 6882
  },
  {
    "nombre": "Fernet Branca - Italia",
    "bottleMl": 750,
    "bottleCost": 14867
  },
  {
    "nombre": "Carpano Dry, Bianco - Italia",
    "bottleMl": 750,
    "bottleCost": 5677
  },
  {
    "nombre": "Pimms- Inglaterra",
    "bottleMl": 750,
    "bottleCost": 365
  },
  {
    "nombre": "Brancamenta – Italia",
    "bottleMl": 750,
    "bottleCost": 5439
  },
  {
    "nombre": "Gancia",
    "bottleMl": 750,
    "bottleCost": 4707
  },
  {
    "nombre": "Cynar - Italia",
    "bottleMl": 750,
    "bottleCost": 4978
  },
  {
    "nombre": "Punt E Mes – Italia",
    "bottleMl": 750,
    "bottleCost": 5894
  },
  {
    "nombre": "Amargo Obrero - Argentina",
    "bottleMl": 750,
    "bottleCost": 1445
  },
  {
    "nombre": "Cinzano",
    "bottleMl": 750,
    "bottleCost": 4170
  },
  {
    "nombre": "Jerez Tio Pepe",
    "bottleMl": 750,
    "bottleCost": 14239
  },
  {
    "nombre": "Monkey 47 - Alemania",
    "bottleMl": 500,
    "bottleCost": 38390
  },
  {
    "nombre": "Mare - Barcelona",
    "bottleMl": 750,
    "bottleCost": 58535
  },
  {
    "nombre": "Hendricks - Escocia",
    "bottleMl": 500,
    "bottleCost": 44861
  },
  {
    "nombre": "The Botanist - Inglaterra",
    "bottleMl": 750,
    "bottleCost": 50399
  },
  {
    "nombre": "Martin Miller´s - Inglaterra",
    "bottleMl": 750,
    "bottleCost": 18955
  },
  {
    "nombre": "Apóstoles - Argentina",
    "bottleMl": 750,
    "bottleCost": 10110
  },
  {
    "nombre": "Bombay Sapphire - Inglaterra",
    "bottleMl": 750,
    "bottleCost": 23430
  },
  {
    "nombre": "Brokers - Inglaterra",
    "bottleMl": 750,
    "bottleCost": 7686
  },
  {
    "nombre": "Beefeater - Inglaterra",
    "bottleMl": 750,
    "bottleCost": 13730
  },
  {
    "nombre": "Gordons - Inglaterra",
    "bottleMl": 750,
    "bottleCost": 9699
  },
  {
    "nombre": "Bulldog - Inglaterra",
    "bottleMl": 750,
    "bottleCost": 13679
  },
  {
    "nombre": "Heredero",
    "bottleMl": 500,
    "bottleCost": 8905
  },
  {
    "nombre": "Tanqueray",
    "bottleMl": 750,
    "bottleCost": 22788
  },
  {
    "nombre": "Zacapa xo - Guatemala",
    "bottleMl": 750,
    "bottleCost": 175000
  },
  {
    "nombre": "Zacapa 23 - Guatemala",
    "bottleMl": 750,
    "bottleCost": 128857
  },
  {
    "nombre": "Havana club añejo - Cuba",
    "bottleMl": 750,
    "bottleCost": 15655
  },
  {
    "nombre": "Malibú - Barbados",
    "bottleMl": 750,
    "bottleCost": 8662
  },
  {
    "nombre": "Havana club 7 años - Cuba",
    "bottleMl": 750,
    "bottleCost": 18217
  },
  {
    "nombre": "Bacardi blanco",
    "bottleMl": 750,
    "bottleCost": 13000
  },
  {
    "nombre": "Bacardi Dorado",
    "bottleMl": 750,
    "bottleCost": 13000
  },
  {
    "nombre": "Cachaca",
    "bottleMl": 750,
    "bottleCost": 4908
  },
  {
    "nombre": "Santa Teresa",
    "bottleMl": 750,
    "bottleCost": 11305
  },
  {
    "nombre": "Grey Goose – Francia",
    "bottleMl": 750,
    "bottleCost": 68724
  },
  {
    "nombre": "Belvedere – Polonia",
    "bottleMl": 750,
    "bottleCost": 43337
  },
  {
    "nombre": "Ciroc – Francia",
    "bottleMl": 750,
    "bottleCost": 43610
  },
  {
    "nombre": "Zubrowka – Polonia",
    "bottleMl": 750,
    "bottleCost": 56985
  },
  {
    "nombre": "Absolut 40% - Suecia",
    "bottleMl": 750,
    "bottleCost": 13500
  },
  {
    "nombre": "Absolut Saborizados - Suecia",
    "bottleMl": 750,
    "bottleCost": 13500
  },
  {
    "nombre": "Smirnoff – Rusia",
    "bottleMl": 750,
    "bottleCost": 5910
  },
  {
    "nombre": "Sernova – Italia",
    "bottleMl": 750,
    "bottleCost": 5468
  },
  {
    "nombre": "Tequila patrón reposado",
    "bottleMl": 750,
    "bottleCost": 90500
  },
  {
    "nombre": "Tequila patrón Silver",
    "bottleMl": 750,
    "bottleCost": 98317
  },
  {
    "nombre": "José cuervo reposado",
    "bottleMl": 750,
    "bottleCost": 26000
  },
  {
    "nombre": "José cuervo blanco",
    "bottleMl": 750,
    "bottleCost": 29500
  },
  {
    "nombre": "Don Julio",
    "bottleMl": 750,
    "bottleCost": 119286
  },
  {
    "nombre": "Mezcal",
    "bottleMl": 750,
    "bottleCost": 78500
  },
  {
    "nombre": "Johnnie Walker Blue Label",
    "bottleMl": 750,
    "bottleCost": 243000
  },
  {
    "nombre": "Royal Salute",
    "bottleMl": 750,
    "bottleCost": 14000
  },
  {
    "nombre": "Johnnie Walker Gold Label",
    "bottleMl": 750,
    "bottleCost": 60323
  },
  {
    "nombre": "Johnnie Walker 18 años",
    "bottleMl": 750,
    "bottleCost": 98662
  },
  {
    "nombre": "Old Parr",
    "bottleMl": 750,
    "bottleCost": 28277
  },
  {
    "nombre": "Chivas Regal",
    "bottleMl": 750,
    "bottleCost": 35300
  },
  {
    "nombre": "Johnnie Walker Double Black",
    "bottleMl": 750,
    "bottleCost": 44200
  },
  {
    "nombre": "Johnnie Walker Red Label",
    "bottleMl": 750,
    "bottleCost": 21700
  },
  {
    "nombre": "The Famous Grouse",
    "bottleMl": 750,
    "bottleCost": 631
  },
  {
    "nombre": "J&B",
    "bottleMl": 750,
    "bottleCost": 24151
  },
  {
    "nombre": "Johnnie Walker Black Label",
    "bottleMl": 750,
    "bottleCost": 38500
  },
  {
    "nombre": "Woodford Reserve",
    "bottleMl": 750,
    "bottleCost": 141166
  },
  {
    "nombre": "Buffalo Trace",
    "bottleMl": 750,
    "bottleCost": 56250
  },
  {
    "nombre": "Evan Williams",
    "bottleMl": 750,
    "bottleCost": 34461
  },
  {
    "nombre": "Maker´s Mark",
    "bottleMl": 750,
    "bottleCost": 59500
  },
  {
    "nombre": "Bulleit",
    "bottleMl": 750,
    "bottleCost": 33340
  },
  {
    "nombre": "Jameson",
    "bottleMl": 750,
    "bottleCost": 18500
  },
  {
    "nombre": "Jack Daniel’s",
    "bottleMl": 750,
    "bottleCost": 38500
  },
  {
    "nombre": "Jim Beam",
    "bottleMl": 750,
    "bottleCost": 30500
  },
  {
    "nombre": "Wild Turkey",
    "bottleMl": 750,
    "bottleCost": 26300
  },
  {
    "nombre": "Benchmark",
    "bottleMl": 750,
    "bottleCost": 25274
  },
  {
    "nombre": "The Macallan 12 YO",
    "bottleMl": 700,
    "bottleCost": 156100
  },
  {
    "nombre": "Johnnie W. Green L. 15 años",
    "bottleMl": 750,
    "bottleCost": 95000
  },
  {
    "nombre": "Glenmorangie 10 años",
    "bottleMl": 750,
    "bottleCost": 59000
  },
  {
    "nombre": "Glenlivet 12 años",
    "bottleMl": 700,
    "bottleCost": 37200
  },
  {
    "nombre": "Glenfiddich 12 años",
    "bottleMl": 700,
    "bottleCost": 93430
  },
  {
    "nombre": "Talisker 10 años",
    "bottleMl": 750,
    "bottleCost": 103478
  },
  {
    "nombre": "Cardhu 12 años",
    "bottleMl": 750,
    "bottleCost": 139000
  },
  {
    "nombre": "The Macallan 18 YO",
    "bottleMl": 750,
    "bottleCost": 566352
  },
  {
    "nombre": "The Macallan 15 YO",
    "bottleMl": 750,
    "bottleCost": 380520
  },
  {
    "nombre": "Monkey Shoulder",
    "bottleMl": 750,
    "bottleCost": 25100
  },
  {
    "nombre": "St. Germain - Francia",
    "bottleMl": 750,
    "bottleCost": 66531
  },
  {
    "nombre": "Strega - Italia",
    "bottleMl": 750,
    "bottleCost": 2660
  },
  {
    "nombre": "Grappa Candolini- Italia",
    "bottleMl": 750,
    "bottleCost": 4268
  },
  {
    "nombre": "Grand Marnier - Francia",
    "bottleMl": 750,
    "bottleCost": 21000
  },
  {
    "nombre": "Drambuie - Escocia",
    "bottleMl": 750,
    "bottleCost": 36000
  },
  {
    "nombre": "Chartreuse - Francia",
    "bottleMl": 750,
    "bottleCost": 358
  },
  {
    "nombre": "Legui - Argentina",
    "bottleMl": 750,
    "bottleCost": 200
  },
  {
    "nombre": "Sambuca Borguetti - Italia",
    "bottleMl": 750,
    "bottleCost": 25130
  },
  {
    "nombre": "Absenta La Tour Tourne",
    "bottleMl": 750,
    "bottleCost": 340
  },
  {
    "nombre": "Jägermeister - Alemania",
    "bottleMl": 750,
    "bottleCost": 17800
  },
  {
    "nombre": "Amaretto Disaronno - Italia",
    "bottleMl": 750,
    "bottleCost": 27200
  },
  {
    "nombre": "Baileys - Irlanda",
    "bottleMl": 750,
    "bottleCost": 22850
  },
  {
    "nombre": "Borguetti - Italia",
    "bottleMl": 750,
    "bottleCost": 12400
  },
  {
    "nombre": "Amarula - Sudáfrica",
    "bottleMl": 750,
    "bottleCost": 22300
  },
  {
    "nombre": "Limoncello - Italia",
    "bottleMl": 750,
    "bottleCost": 24586
  },
  {
    "nombre": "Hesperidina - Argentina",
    "bottleMl": 750,
    "bottleCost": 9326
  },
  {
    "nombre": "Cointreau - Francia",
    "bottleMl": 750,
    "bottleCost": 36900
  },
  {
    "nombre": "Pisco",
    "bottleMl": 750,
    "bottleCost": 18177
  },
  {
    "nombre": "Tia Maria",
    "bottleMl": 750,
    "bottleCost": 6672
  },
  {
    "nombre": "Frangelico- Italia",
    "bottleMl": 750,
    "bottleCost": 23500
  },
  {
    "nombre": "Licor 43",
    "bottleMl": 750,
    "bottleCost": 30289
  },
  {
    "nombre": "Lepanto – España",
    "bottleMl": 750,
    "bottleCost": 3175
  },
  {
    "nombre": "Hennessy VS – Francia",
    "bottleMl": 750,
    "bottleCost": 43600
  },
  {
    "nombre": "Hennessy VSOP – Francia",
    "bottleMl": 750,
    "bottleCost": 61000
  }
];

(async () => {
  const productos = await db.all2("SELECT id, nombre, precio_unitario FROM productos_ayb");

  console.log('====================================================');
  console.log('ACTUALIZAR PRECIOS — Destilados/Aperitivos (planilla Sept 2026)');
  console.log('====================================================');
  console.log(`Productos en la planilla: ${PRECIOS.length}`);
  console.log('');

  const aActualizar = [];
  const yaTienenOtroPrecio = [];
  const sinMatch = [];

  for (const item of PRECIOS) {
    const precioPorMl = item.bottleCost / item.bottleMl;
    const match = mejorMatch(item.nombre, productos);
    if (!match) {
      sinMatch.push(item);
      continue;
    }
    const precioActual = parseFloat(match.precio_unitario) || 0;
    if (precioActual > 0 && !forzarTodos) {
      yaTienenOtroPrecio.push({ item, match, precioPorMl, precioActual });
      continue;
    }
    aActualizar.push({ item, match, precioPorMl, precioActual });
  }

  console.log(`--- Se van a actualizar (${aActualizar.length}) ---`);
  aActualizar.forEach(a => console.log(`  "${a.item.nombre}" → matchea "${a.match.nombre}" | precio actual: ${a.precioActual} → nuevo: ${a.precioPorMl.toFixed(3)} (por ml)`));
  console.log('');

  console.log(`--- Ya tienen OTRO precio cargado, no se tocan salvo --forzar-todos (${yaTienenOtroPrecio.length}) ---`);
  yaTienenOtroPrecio.forEach(a => console.log(`  "${a.item.nombre}" → matchea "${a.match.nombre}" | precio actual: ${a.precioActual} (planilla sugiere: ${a.precioPorMl.toFixed(3)})`));
  console.log('');

  console.log(`--- SIN match en tu catálogo (${sinMatch.length}) ---`);
  sinMatch.forEach(a => console.log(`  "${a.nombre}"`));
  console.log('');

  if (!ejecutar) {
    console.log('MODO PRUEBA — no se cambió nada todavía.');
    console.log('Si el reporte se ve bien, correr de nuevo así:');
    console.log('  node actualizar_precios_destilados.js --ejecutar');
    process.exit(0);
  }

  if (aActualizar.length === 0) {
    console.log('No hay nada para actualizar.');
    process.exit(0);
  }

  for (const a of aActualizar) {
    await db.run2('UPDATE productos_ayb SET precio_unitario=$1 WHERE id=$2', [a.precioPorMl, a.match.id]);
  }
  console.log(`✔ Actualizados ${aActualizar.length} productos.`);

  // Recalcular el costo_total de cualquier trago que use alguno de estos productos
  const idsActualizados = aActualizar.map(a => a.match.id);
  const platosAfectados = await db.all2(
    `SELECT DISTINCT plato_id FROM plato_insumos_ayb WHERE insumo_id = ANY($1)`,
    [idsActualizados]
  );
  for (const { plato_id } of platosAfectados) {
    await db.run2(
      `UPDATE plato_insumos_ayb SET costo_parcial = cantidad * (SELECT precio_unitario FROM productos_ayb WHERE id = plato_insumos_ayb.insumo_id) WHERE plato_id=$1`,
      [plato_id]
    );
    const suma = await db.get2('SELECT COALESCE(SUM(costo_parcial),0) AS total FROM plato_insumos_ayb WHERE plato_id=$1', [plato_id]);
    await db.run2('UPDATE platos_costo SET costo_total=$1 WHERE id=$2', [suma.total, plato_id]);
  }
  console.log(`✔ Recalculado el costo_total de ${platosAfectados.length} trago(s)/plato(s) que usan estos productos.`);
  console.log('Listo.');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
