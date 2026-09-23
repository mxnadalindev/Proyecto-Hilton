// completar_7_pendientes.js
//
// Completa los 7 tragos que hoy siguen en $0 en Costos (AYB): Boulivardier,
// Caipiriña, Fernet Cola, Gimlet, Manhattan, Two Smoking Barrels y Vodka
// Tonic. Las cantidades salen de la segunda planilla que pasó Maxi (la de
// formato "INGREDIENTES / PESO NETO / UNIDAD DE COMPRA / PRECIO / COSTO"),
// que sí tiene estos 7 tragos con nombre exacto.
//
// OJO: el costo que muestra este script se calcula con el PRECIO ACTUAL
// que ya está cargado en Inventario AYB para cada producto (igual que hace
// la pantalla de Costos), no con el precio "PRECIO UNIDAD DE COMPRA" de la
// planilla — porque ese precio de la planilla puede estar desactualizado.
// Sólo usamos de la planilla las CANTIDADES (peso neto) y qué ingrediente
// va en cada trago.
//
// Seguridad: SOLO toca un trago si:
//   1) Su nombre es EXACTAMENTE uno de los 7 de la lista (departamento ayb)
//   2) Hoy no tiene NINGÚN ingrediente cargado (si ya tiene algo, no se
//      toca, para no pisar nada que hayas cargado vos mismo mientras tanto)
//
// Uso:
//   1) Modo prueba (no cambia nada):   node completar_7_pendientes.js
//   2) Si el reporte se ve bien:       node completar_7_pendientes.js --ejecutar

const db = require('./src/db/database');
const ejecutar = process.argv.includes('--ejecutar');

function normalizarTexto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(p => p.length > 1);
}
// Ver nota en cargar_recetas_worksheet.js sobre por qué el puntaje es
// asimétrico (fracción de las palabras del ingrediente BUSCADO que aparecen
// en el candidato), más un filtro extra de precisión cuando sólo matchea
// una palabra genérica de un término de varias palabras.
function puntajeSimilitud(buscado, candidato) {
  const pa = normalizarTexto(buscado);
  const pb = normalizarTexto(candidato);
  const pbSet = new Set(pb);
  if (!pa.length || !pbSet.size) return 0;
  const comunes = pa.filter(p => pbSet.has(p)).length;
  if (comunes === 0) return 0;
  if (comunes === 1 && pa.length >= 2) {
    const precision = comunes / pb.length;
    if (precision < 0.34) return 0;
  }
  return comunes / pa.length;
}

// ── Datos de la 2da planilla (sólo los 7 tragos pendientes) ──
const PENDIENTES = [
  { nombreExacto: 'Boulivardier', ingredientes: [
    ['Whisky JW Red', 60, 'ml'], ['Campari', 60, 'ml'], ['Vermouth', 60, 'ml'], ['Naranja', 1, 'unidad'] ] },
  { nombreExacto: 'Caipiriña', ingredientes: [
    ['Cachaza', 60, 'ml'], ['Azucar', 30, 'gr'], ['Limon', 2, 'unidad'] ] },
  { nombreExacto: 'Fernet Cola', ingredientes: [
    ['Fernet', 60, 'ml'], ['Coca Cola', 200, 'ml'] ] },
  { nombreExacto: 'Gimlet', ingredientes: [
    ['Gin Heredero', 60, 'ml'], ['Jugo Naranja o Limón', 60, 'ml'], ['Miel', 20, 'gr'], ['Limón', 1, 'unidad'] ] },
  { nombreExacto: 'Manhattan', ingredientes: [
    ['Whisky Jim Beam', 60, 'ml'], ['Vermouth', 60, 'ml'], ['Bitter de Angostura', 5, 'ml'], ['Naranja', 1, 'unidad'] ] },
  { nombreExacto: 'Two Smoking Barrels', ingredientes: [
    ['jack daniel', 60, 'ml'], ['Fernet', 5, 'ml'], ['campari', 5, 'ml'], ['oleo calcareo', 30, 'ml'] ] },
  { nombreExacto: 'Vodka Tonic', ingredientes: [
    ['Vodka Sernova', 60, 'ml'], ['Tonica', 1, 'unidad'], ['Lima', 1, 'unidad'] ] },
];

(async () => {
  const productos = await db.all2("SELECT id, nombre, precio_unitario, unidad_default FROM productos_ayb WHERE activo=true");

  console.log('====================================================');
  console.log('COMPLETAR los 7 tragos pendientes (2da planilla)');
  console.log('====================================================');

  const acciones = [];
  const noEncontrados = [];

  for (const item of PENDIENTES) {
    const plato = await db.get2(
      "SELECT id, nombre FROM platos_costo WHERE departamento='ayb' AND nombre=$1",
      [item.nombreExacto]
    );
    if (!plato) {
      console.log(`- "${item.nombreExacto}": no se encontró ningún trago con ese nombre exacto en Costos. Se omite.`);
      noEncontrados.push(item.nombreExacto);
      continue;
    }
    const cnt = await db.get2('SELECT COUNT(*)::int AS c FROM plato_insumos_ayb WHERE plato_id=$1', [plato.id]);
    if (cnt?.c > 0) {
      console.log(`- "${item.nombreExacto}" (#${plato.id}): ya tiene ${cnt.c} ingrediente(s) cargado(s). No se toca.`);
      continue;
    }

    const ingredientesMatch = item.ingredientes.map(([nombreIng, cantidad, unidad]) => {
      const mejor = productos
        .map(p => ({ ...p, score: puntajeSimilitud(nombreIng, p.nombre) }))
        .filter(p => p.score >= 0.5)
        .sort((a, b) => b.score - a.score)[0];
      return { nombreIng, cantidad, unidad, match: mejor || null };
    });

    console.log(`- "${item.nombreExacto}" (#${plato.id}):`);
    ingredientesMatch.forEach(i => {
      if (i.match) console.log(`    ✔ ${i.nombreIng} (${i.cantidad}${i.unidad}) → matchea con "${i.match.nombre}" (precio: ${i.match.precio_unitario ?? '(sin precio)'})`);
      else console.log(`    ✘ ${i.nombreIng} (${i.cantidad}${i.unidad}) → SIN MATCH, no se va a cargar este ingrediente`);
    });

    acciones.push({ platoId: plato.id, nombre: item.nombreExacto, ingredientesMatch });
  }

  console.log('');
  const sinMatchTotal = acciones.reduce((s, a) => s + a.ingredientesMatch.filter(i => !i.match).length, 0);
  console.log(`⚠ Total de ingredientes SIN match: ${sinMatchTotal} (van a quedar afuera de la receta, agregalos a mano después si hace falta)`);
  console.log('');

  if (!ejecutar) {
    console.log('MODO PRUEBA — no se cambió nada todavía.');
    console.log('Si el reporte se ve bien, correr de nuevo así:');
    console.log('  node completar_7_pendientes.js --ejecutar');
    process.exit(0);
  }

  if (acciones.length === 0) {
    console.log('No hay nada para hacer.');
    process.exit(0);
  }

  for (const accion of acciones) {
    let total = 0;
    for (const i of accion.ingredientesMatch) {
      if (!i.match) continue;
      const costo_parcial = i.cantidad * i.match.precio_unitario;
      await db.run2(
        'INSERT INTO plato_insumos_ayb (plato_id, insumo_id, cantidad, unidad, costo_parcial) VALUES ($1,$2,$3,$4,$5)',
        [accion.platoId, i.match.id, i.cantidad, i.unidad, costo_parcial]
      );
      total += costo_parcial;
    }
    await db.run2('UPDATE platos_costo SET costo_total=$1 WHERE id=$2', [total, accion.platoId]);
    console.log(`✔ "${accion.nombre}" (#${accion.platoId}) → costo total: $${total.toFixed(2)}`);
  }
  console.log('Listo.');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
