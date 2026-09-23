// actualizar_precios_bebidas.js
//
// Completa el precio de las 23 cervezas/gaseosas/aguas de la lista de
// "Location 220" que el script anterior (actualizar_precios_por_codigo.js)
// dejó afuera a propósito, porque a diferencia de una botella de fernet o
// whisky, estas vienen en distintas unidades de compra (pack de 6, caja de
// 24, barril de 20/50 litros, lata o botella individual) y hacía falta
// resolver esa cuenta antes de cargar cualquier cosa.
//
// Lógica de conversión a precio por ml (así lo usa Costos):
//   1) Si el nombre dice "X 6" o "X 24UN" (pack/caja), el precio de la
//      lista es por PACK completo — se divide primero por esa cantidad
//      para sacar el precio de UNA lata.
//   2) Después, el tamaño de esa lata/botella/barril se lee del propio
//      nombre cuando lo dice explícito (ej. "473 CC", "437 ML", "50LT").
//      Cuando el nombre NO trae el tamaño (Heineken, Quilmes lata,
//      Coca-Cola, Fanta, Sprite, Schweppes — todos vienen como "LATA X N"
//      sin decir cuántos cc), se asume 354ml, que es el tamaño de lata
//      estándar en Argentina — pero esto es un supuesto, no un dato de tu
//      lista, así que quedan marcados como "tamaño asumido" en el reporte
//      para que los revises.
//
// Un caso raro: "CERVEZA MICHELOB LATA 473 CC" tiene precio $0,01 en tu
// lista — es un valor tan bajo que probablemente sea un error de carga en
// el sistema de origen, no un precio real. Se incluye igual (es el dato
// que trae tu lista), pero se marca aparte para que lo confirmes.
//
// "TUBO DE GAS QUILMES X 10KG" se excluye directamente: es un insumo de
// dispensado (CO2), no una bebida que se sirva en un trago, así que no
// tiene sentido cargarle un precio "por ml".
//
// Seguridad: igual que los scripts anteriores, por defecto SOLO actualiza
// productos que hoy están en $0 — no pisa un precio ya cargado, salvo que
// agregues --forzar-todos.
//
// Uso:
//   1) Modo prueba (no cambia nada):
//        node actualizar_precios_bebidas.js
//   2) Si el reporte se ve bien:
//        node actualizar_precios_bebidas.js --ejecutar

const db = require('./src/db/database');
const ejecutar = process.argv.includes('--ejecutar');
const forzarTodos = process.argv.includes('--forzar-todos');

const TAMANO_LATA_ASUMIDO_ML = 354; // lata estándar en Argentina

const LISTA = [
  { codigo: '220003', nombre: 'CERVEZA CORONA 330 PORRON', costo: 2324.79 },
  { codigo: '220006', nombre: 'CERVEZA HEINEKEN LATA X 24UN', costo: 1944.44 },
  { codigo: '220011', nombre: 'CERVEZA QUILMES BARRIL 50LT', costo: 131968.07 },
  { codigo: '220013', nombre: 'CERVEZA QUILMES LATA X 24UN.', costo: 1431.56 },
  { codigo: '220014', nombre: 'CERVEZA MICHELOB LATA 473 CC', costo: 0.01, sospechoso: true },
  { codigo: '220019', nombre: 'CERVEZA STELLA ART. BARR X 20L', costo: 88338.62 },
  { codigo: '220039', nombre: 'CERVEZA STELLA ARTOIS LATA 473CC', costo: 2088.93 },
  { codigo: '220041', nombre: 'CERVEZA STELLA LATA SIN ALCOHOL 473 CC', costo: 1714.31 },
  { codigo: '220042', nombre: 'CERVEZA ANDES ORIGEN IPA LATA 437 ML', costo: 1904.54 },
  { codigo: '220043', nombre: 'CERVEZA ANDES ORIGEN NEGRA LATA 437 ML', costo: 1910.85 },
  { codigo: '220044', nombre: 'CERVEZA ANDES ORIGEN ROJA LATA 437 ML', costo: 1897.88 },
  { codigo: '240091', nombre: 'AGUA AQUARIUS  POMELO 500cc.', costo: 1065.89 },
  { codigo: '240092', nombre: 'AGUA AQUARIUS MANZANA 500cc.', costo: 1063.41 },
  { codigo: '240093', nombre: 'SPEED LATA 250', costo: 823.10 },
  { codigo: '240183', nombre: 'AGUA SMARTWATER 591CC S/GAS', costo: 641.54 },
  { codigo: '240184', nombre: 'AGUA SMARTWATER 591CC C/GAS', costo: 633.21 },
  { codigo: '270002', nombre: 'COCA COLA (LATA) X 6', costo: 1077.28 },
  { codigo: '270010', nombre: 'FANTA NARANJA ZERO LATA X 6', costo: 1012.93 },
  { codigo: '270020', nombre: 'SCHWEPPS TONICA LATA X 24UN', costo: 1099.45 },
  { codigo: '270023', nombre: 'SPRITE (LATA) x 6', costo: 1032.75 },
  { codigo: '270024', nombre: 'SPRITE ZERO (LATA) x 6', costo: 1054.14 },
  { codigo: '270061', nombre: 'COCA COLA ZERO LATA x 6', costo: 1084.11 },
  // 220017 TUBO DE GAS QUILMES X 10KG -- excluido a propósito, no es una bebida
];

function parsearPack(nombre) {
  const m = nombre.toUpperCase().match(/X\s?(\d{1,2})\s?(UN)?\b/);
  return m ? parseInt(m[1], 10) : 1;
}
function parsearTamanoMl(nombre) {
  const n = nombre.toUpperCase();
  let m = n.match(/(\d{2,3})\s?(CC|ML)\b/);
  if (m) return { ml: parseInt(m[1], 10), asumido: false };
  m = n.match(/(\d{2,3})\s?CC\.?\s*$/);
  if (m) return { ml: parseInt(m[1], 10), asumido: false };
  m = n.match(/(\d{2,3})\b\s*(PORRON|LATA)/);
  if (m) return { ml: parseInt(m[1], 10), asumido: false };
  if (/LATA\s+(\d{3})\b/.test(n)) return { ml: parseInt(n.match(/LATA\s+(\d{3})\b/)[1], 10), asumido: false };
  m = n.match(/(\d{2,3})\s*$/); // ej. "SPEED LATA 250"
  if (m) return { ml: parseInt(m[1], 10), asumido: false };
  m = n.match(/(\d{2,3})\s?LT\b/);
  if (m) return { ml: parseInt(m[1], 10) * 1000, asumido: false };
  m = n.match(/(\d{2,3})\s?L\b/);
  if (m) return { ml: parseInt(m[1], 10) * 1000, asumido: false };
  return { ml: TAMANO_LATA_ASUMIDO_ML, asumido: true };
}

(async () => {
  const productos = await db.all2("SELECT id, nombre, precio_unitario, codigo_barras FROM productos_ayb");
  const porCodigo = new Map(productos.filter(p => p.codigo_barras).map(p => [String(p.codigo_barras).trim(), p]));

  console.log('====================================================');
  console.log('ACTUALIZAR PRECIOS — Cervezas / gaseosas / aguas (Location 220)');
  console.log('====================================================');

  const aActualizar = [];
  const yaTienenOtroPrecio = [];
  const sinMatch = [];
  const tamanoAsumido = [];
  const sospechosos = [];

  for (const item of LISTA) {
    const match = porCodigo.get(item.codigo);
    if (!match) { sinMatch.push(item); continue; }

    const pack = parsearPack(item.nombre);
    const costoPorUnidad = item.costo / pack;
    const { ml, asumido } = parsearTamanoMl(item.nombre);
    const precioPorMl = costoPorUnidad / ml;
    const precioActual = parseFloat(match.precio_unitario) || 0;

    const detalle = { item, match, precioPorMl, precioActual, pack, ml, asumido };
    if (asumido) tamanoAsumido.push(detalle);
    if (item.sospechoso) sospechosos.push(detalle);

    if (precioActual > 0 && !forzarTodos) yaTienenOtroPrecio.push(detalle);
    else aActualizar.push(detalle);
  }

  console.log(`--- Se van a actualizar (${aActualizar.length}) ---`);
  aActualizar.forEach(d => console.log(`  [${d.item.codigo}] "${d.item.nombre}" → "${d.match.nombre}" | pack: ${d.pack} | tamaño: ${d.ml}ml${d.asumido ? ' (asumido)' : ''} | precio actual: ${d.precioActual} → nuevo: ${d.precioPorMl.toFixed(3)} (por ml)`));
  console.log('');

  console.log(`--- Ya tienen OTRO precio, no se tocan salvo --forzar-todos (${yaTienenOtroPrecio.length}) ---`);
  yaTienenOtroPrecio.forEach(d => console.log(`  [${d.item.codigo}] "${d.item.nombre}" → precio actual: ${d.precioActual} (lista sugiere: ${d.precioPorMl.toFixed(3)})`));
  console.log('');

  console.log(`--- SIN match por código (${sinMatch.length}) ---`);
  sinMatch.forEach(i => console.log(`  [${i.codigo}] "${i.nombre}"`));
  console.log('');

  if (tamanoAsumido.length) {
    console.log(`⚠ A estos se les asumió lata de ${TAMANO_LATA_ASUMIDO_ML}ml porque el nombre no lo especifica — revisar si corresponde:`);
    tamanoAsumido.forEach(d => console.log(`  - ${d.item.nombre}`));
    console.log('');
  }
  if (sospechosos.length) {
    console.log(`⚠ Precio sospechosamente bajo en tu lista original (probable error de carga en el sistema de origen, no de este script) — revisar antes de confiar en el número:`);
    sospechosos.forEach(d => console.log(`  - ${d.item.nombre} ($${d.item.costo})`));
    console.log('');
  }

  if (!ejecutar) {
    console.log('MODO PRUEBA — no se cambió nada todavía.');
    console.log('Si el reporte se ve bien, correr de nuevo así:');
    console.log('  node actualizar_precios_bebidas.js --ejecutar');
    process.exit(0);
  }

  if (aActualizar.length === 0) {
    console.log('No hay nada para actualizar.');
    process.exit(0);
  }

  for (const d of aActualizar) {
    await db.run2('UPDATE productos_ayb SET precio_unitario=$1 WHERE id=$2', [d.precioPorMl, d.match.id]);
  }
  console.log(`✔ Actualizados ${aActualizar.length} productos.`);

  const idsActualizados = aActualizar.map(d => d.match.id);
  const platosAfectados = await db.all2('SELECT DISTINCT plato_id FROM plato_insumos_ayb WHERE insumo_id = ANY($1)', [idsActualizados]);
  for (const { plato_id } of platosAfectados) {
    await db.run2(
      'UPDATE plato_insumos_ayb SET costo_parcial = cantidad * (SELECT precio_unitario FROM productos_ayb WHERE id = plato_insumos_ayb.insumo_id) WHERE plato_id=$1',
      [plato_id]
    );
    const suma = await db.get2('SELECT COALESCE(SUM(costo_parcial),0) AS total FROM plato_insumos_ayb WHERE plato_id=$1', [plato_id]);
    await db.run2('UPDATE platos_costo SET costo_total=$1 WHERE id=$2', [suma.total, plato_id]);
  }
  console.log(`✔ Recalculado el costo_total de ${platosAfectados.length} trago(s)/plato(s).`);
  console.log('Listo.');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
