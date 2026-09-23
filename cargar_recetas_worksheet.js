// cargar_recetas_worksheet.js
//
// Carga los 28 tragos del "Beverage Profitability Worksheet" (los 21
// clásicos de la carta + los 7 de autor/firma) en el módulo de Costos,
// con sus ingredientes y cantidades. Los precios de costo/rentabilidad
// que traía la planilla original NO se usan (varios tenían errores #REF!
// de fórmulas rotas) — el costo se recalcula siempre con el precio que
// ya está cargado en el sistema (Inventario AYB / Costos → Insumos).
//
// Para cada trago:
//  - Si YA existe un trago con ese nombre (o muy parecido) en Costos, y
//    YA tiene ingredientes cargados, no se toca — se lista para revisión
//    manual, así no se pisa nada que el usuario ya haya armado.
//  - Si existe pero está vacío (0 ingredientes) — es el caso de Manhattan
//    y Caipiriña, que ya detectamos en $0 — se le cargan los ingredientes
//    de la planilla.
//  - Si no existe, se crea nuevo.
//
// Cada ingrediente de la planilla se matchea contra el catálogo de
// Inventario AYB (productos_ayb, activos) por nombre — igual criterio que
// ya usa el reconocimiento de botellas por foto (comparación de palabras
// en común, sin acentos). Si no hay un match razonablemente confiable, ese
// ingrediente se deja SIN cargar y se lista aparte para agregarlo a mano.
//
// Uso:
//   1) Modo prueba (no cambia nada):   node cargar_recetas_worksheet.js
//   2) Si el reporte se ve bien:       node cargar_recetas_worksheet.js --ejecutar

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
// OJO: a diferencia del reconocimiento de botellas por foto (que compara
// dos nombres del mismo "largo"), acá buscamos un ingrediente con nombre
// CORTO (ej. "ron bacardi") dentro del catálogo real, que casi siempre
// tiene nombres más largos y descriptivos (ej. "RON BACARDI CARTA BLANCA
// x 980"). Por eso el puntaje se calcula como "qué fracción de las
// palabras del ingrediente buscado aparece en el candidato" — no al revés
// — así un nombre corto puede matchear bien contra uno más largo mientras
// contenga sus palabras clave.
function puntajeSimilitud(buscado, candidato) {
  const pa = normalizarTexto(buscado);
  const pb = normalizarTexto(candidato);
  const pbSet = new Set(pb);
  if (!pa.length || !pbSet.size) return 0;
  const comunes = pa.filter(p => pbSet.has(p)).length;
  if (comunes === 0) return 0;
  // Filtro extra de seguridad: cuando el ingrediente buscado tiene VARIAS
  // palabras (ej. "vermouth blanco") pero sólo UNA de ellas aparece en el
  // candidato, esa única palabra suele ser un adjetivo genérico ("blanco",
  // "rojo", "seco"...) que puede aparecer en un producto totalmente
  // distinto (ej. "TEQUILA CUERVO BLANCO"). Para evitar ese falso
  // positivo, en ese caso exigimos además que esa palabra sea una porción
  // importante del nombre del candidato (no un nombre largo con muchas
  // otras palabras propias, como una marca distinta). Si coinciden 2 o
  // más palabras, el match ya es lo bastante específico y no hace falta
  // este chequeo extra (ej. "Johnnie Walker Red Label" → coincide
  // "walker"+"red" contra "WHISKY J.WALKER RED", eso sí es confiable).
  if (comunes === 1 && pa.length >= 2) {
    const precision = comunes / pb.length;
    if (precision < 0.34) return 0;
  }
  return comunes / pa.length;
}

// ── Datos de la planilla (nombre del trago, categoría sugerida, ingredientes) ──
// unidad: 'ml' salvo que se indique 'unidad' (guarniciones/aceitunas/etc.)
const RECETAS = [
  { nombre: 'Daiquiri', categoria: 'Tragos clásicos', ingredientes: [
    ['ron bacardi', 60, 'ml'], ['jugo limon', 50, 'ml'], ['syrup', 50, 'ml'] ] },
  { nombre: 'Bloody Mary', categoria: 'Tragos clásicos', ingredientes: [
    ['vodka smirnoff', 60, 'ml'], ['jugo tomate', 120, 'ml'], ['jugo limon', 10, 'ml'], ['Rodaja de Limon', 1, 'unidad'] ] },
  { nombre: 'Cocktail Martini', categoria: 'Tragos clásicos', ingredientes: [
    ['gin beefeater', 75, 'ml'], ['vermouth seco', 10, 'ml'], ['Aceituna', 1, 'unidad'] ] },
  { nombre: 'Cosmopolitan', categoria: 'Tragos clásicos', ingredientes: [
    ['vodka smirnoff', 60, 'ml'], ['triple sec', 30, 'ml'], ['jugo cranberry', 20, 'ml'] ] },
  { nombre: 'Mai Tai', categoria: 'Tragos clásicos', ingredientes: [
    ['ron bacardi', 60, 'ml'], ['amaretto', 20, 'ml'], ['jugo de naranja', 40, 'ml'], ['jugo anana', 20, 'ml'], ['limon', 10, 'ml'] ] },
  { nombre: 'Margarita', categoria: 'Tragos clásicos', ingredientes: [
    ['tequila cuervo blanco', 60, 'ml'], ['triple sec', 20, 'ml'], ['jugo limon', 10, 'ml'] ] },
  { nombre: 'Bourbon Manhattan', categoria: 'Tragos clásicos', ingredientes: [
    ['Jim Beam', 60, 'ml'], ['vermouth dulce', 30, 'ml'], ['bitter angostura', 1, 'ml'] ],
    posibleDuplicadoDe: 'Manhattan' },
  { nombre: 'Negroni', categoria: 'Tragos clásicos', ingredientes: [
    ['gin beefeater', 60, 'ml'], ['campari', 50, 'ml'], ['vermouth rojo', 50, 'ml'] ] },
  { nombre: 'Old Fashioned', categoria: 'Tragos clásicos', ingredientes: [
    ['Jim Beam', 60, 'ml'], ['bitter angostura', 1, 'ml'] ] },
  { nombre: 'Long Island Ice Tea', categoria: 'Tragos clásicos', ingredientes: [
    ['vodka smirnoff', 20, 'ml'], ['ron bacardi blanco', 20, 'ml'], ['gin beefeater', 20, 'ml'], ['triple sec', 20, 'ml'], ['tequila cuervo blanco', 20, 'ml'], ['limon', 10, 'ml'] ] },
  { nombre: 'Piña Colada', categoria: 'Tragos clásicos', ingredientes: [
    ['ron bacardi blanco', 60, 'ml'], ['Malibu', 30, 'ml'], ['jugo anana', 30, 'ml'] ] },
  { nombre: 'Caipirinha', categoria: 'Tragos clásicos', ingredientes: [
    ['cachaca', 60, 'ml'], ['lima', 50, 'ml'], ['syrup', 50, 'ml'] ],
    posibleDuplicadoDe: 'Caipiriña' },
  { nombre: 'Tom Collins', categoria: 'Tragos clásicos', ingredientes: [
    ['gin beefeater', 60, 'ml'], ['jugo de limon', 20, 'ml'], ['bitter angostura', 1, 'ml'], ['agua con gas', 500, 'ml'] ] },
  { nombre: 'Mojito', categoria: 'Tragos clásicos', ingredientes: [
    ['ron bacardi blanco', 60, 'ml'], ['jugo limon', 10, 'ml'], ['agua con gas', 500, 'ml'], ['menta fresca', 1, 'unidad'] ] },
  { nombre: 'Caipiroska', categoria: 'Tragos clásicos', ingredientes: [
    ['vodka smirnoff', 60, 'ml'], ['lima', 1, 'unidad'], ['syrup', 50, 'ml'] ] },
  { nombre: 'Aperol Spritz', categoria: 'Tragos clásicos', ingredientes: [
    ['aperol', 45, 'ml'], ['agua con gas', 20, 'ml'], ['espumante', 75, 'ml'] ] },
  { nombre: 'Rusty Nail', categoria: 'Tragos clásicos', ingredientes: [
    ['Johnnie Walker Red Label', 45, 'ml'], ['Drambuie', 20, 'ml'] ] },
  { nombre: 'Moscow Mule', categoria: 'Tragos clásicos', ingredientes: [
    ['Vodka Sernova', 60, 'ml'], ['Syrup jengibre', 20, 'ml'], ['jugo de limon', 20, 'ml'], ['cerveza tirada', 1, 'unidad'] ] },
  { nombre: 'Pisco Sour', categoria: 'Tragos clásicos', ingredientes: [
    ['Pisco', 60, 'ml'], ['Clara de huevo', 1, 'unidad'], ['jugo de limon', 20, 'ml'], ['syrup simple', 20, 'ml'] ] },
  { nombre: 'Expresso Martini', categoria: 'Tragos clásicos', ingredientes: [
    ['Vodka Sernova', 45, 'ml'], ['Borguetti', 22, 'ml'], ['Cafe espresso', 20, 'ml'], ['syrup simple', 15, 'ml'] ] },
  { nombre: 'Cynar Julep', categoria: 'Tragos clásicos', ingredientes: [
    ['Cynar', 60, 'ml'], ['jugo de limon', 20, 'ml'], ['jugo de pomelo', 120, 'ml'], ['syrup simple', 20, 'ml'], ['menta fresca', 1, 'unidad'] ] },
  { nombre: 'El Facón "Tradición"', categoria: 'Tragos de autor', ingredientes: [
    ['Vermouth Blanco', 45, 'ml'], ['Amargo Obrero', 30, 'ml'], ['Fernet Branca', 15, 'ml'], ['Jugo de Pomelo', 30, 'ml'], ['Jugo de Limon', 30, 'ml'], ['Pomelo deshidratado', 1, 'unidad'] ] },
  { nombre: 'Huellas Digitales "Identidad"', categoria: 'Tragos de autor', ingredientes: [
    ['Vodka Sernova', 60, 'ml'], ['Gancia', 30, 'ml'], ['Limoncello', 15, 'ml'], ['Espuma de Marshmallow', 30, 'unidad'] ] },
  { nombre: 'Tango "Pasión y Melancolía"', categoria: 'Tragos de autor', ingredientes: [
    ['Johnnie Walker Red Label', 60, 'ml'], ['Bitter de tabaco y vainilla', 15, 'ml'], ['Bitter de cacao', 15, 'ml'], ['Cordial de hongos', 20, 'ml'], ['Hongos miniatura', 1, 'unidad'] ] },
  { nombre: 'Mate "Unión"', categoria: 'Tragos de autor', ingredientes: [
    ['Ron Havana club añejo', 60, 'ml'], ['Cordial de mate', 60, 'ml'], ['Jugo de Limon', 20, 'ml'], ['Espuma de naranja y fernet menta', 30, 'ml'] ] },
  { nombre: 'La Birome "Escribir"', categoria: 'Tragos de autor', ingredientes: [
    ['Vermouth Bianco', 60, 'ml'], ['Infusión de té verde', 90, 'ml'], ['Almíbar de pepino', 45, 'ml'], ['Limón deshidratado', 1, 'unidad'] ] },
  { nombre: 'El Sifón "Picardía"', categoria: 'Tragos de autor', ingredientes: [
    ['Vino Torrontés', 60, 'ml'], ['Grappa Candolini', 30, 'ml'], ['Almíbar de membrillo', 30, 'ml'], ['Jugo de Limon', 15, 'ml'], ['Limón deshidratado', 1, 'unidad'] ] },
  { nombre: 'Bypass Coronario "Vida"', categoria: 'Tragos de autor', ingredientes: [
    ['Gin Heredero', 60, 'ml'], ['Soda de hibiscus', 90, 'ml'], ['Ramillete de eneldo', 1, 'unidad'] ] },
];

(async () => {
  const platosExistentes = await db.all2("SELECT id, nombre FROM platos_costo WHERE departamento='ayb'");
  const productos = await db.all2("SELECT id, nombre, precio_unitario, unidad_default FROM productos_ayb WHERE activo=true");

  const UMBRAL_INGREDIENTE = 0.5;
  const UMBRAL_NOMBRE_TRAGO = 0.6;

  const resumen = { crear: [], yaExistenVacios: [], yaExistenConDatos: [] };

  for (const receta of RECETAS) {
    // Buscar si ya existe un trago con nombre igual o muy parecido
    let candidato = platosExistentes
      .map(p => ({ ...p, score: puntajeSimilitud(receta.nombre, p.nombre) }))
      .filter(p => p.score >= UMBRAL_NOMBRE_TRAGO)
      .sort((a, b) => b.score - a.score)[0];

    // Si la receta indica explícitamente que puede ser duplicado de un
    // trago existente (ej. "Bourbon Manhattan" ↔ "Manhattan"), preferimos
    // ese match aunque el nombre no calce tan literal.
    if (!candidato && receta.posibleDuplicadoDe) {
      candidato = platosExistentes.find(p => normalizarTexto(p.nombre).join(' ') === normalizarTexto(receta.posibleDuplicadoDe).join(' '));
    }

    let platoId = null;
    let yaExiste = false;
    let ingredientesActuales = 0;

    if (candidato) {
      yaExiste = true;
      platoId = candidato.id;
      const cnt = await db.get2('SELECT COUNT(*)::int AS c FROM plato_insumos_ayb WHERE plato_id=$1', [candidato.id]);
      ingredientesActuales = cnt?.c || 0;
    }

    // Matchear cada ingrediente de la receta contra productos_ayb
    const ingredientesMatch = receta.ingredientes.map(([nombreIng, cantidad, unidad]) => {
      const mejor = productos
        .map(p => ({ ...p, score: puntajeSimilitud(nombreIng, p.nombre) }))
        .filter(p => p.score >= UMBRAL_INGREDIENTE)
        .sort((a, b) => b.score - a.score)[0];
      return { nombreIng, cantidad, unidad, match: mejor || null };
    });

    const item = {
      nombre: receta.nombre, categoria: receta.categoria, platoId,
      ingredientesMatch,
      sinMatch: ingredientesMatch.filter(i => !i.match),
    };

    if (yaExiste && ingredientesActuales > 0) {
      resumen.yaExistenConDatos.push({ ...item, ingredientesActuales });
    } else if (yaExiste && ingredientesActuales === 0) {
      resumen.yaExistenVacios.push(item);
    } else {
      resumen.crear.push(item);
    }
  }

  console.log('====================================================');
  console.log('CARGA DE RECETAS — Beverage Profitability Worksheet');
  console.log('====================================================');
  console.log(`Total en la planilla: ${RECETAS.length}`);
  console.log(`Se van a CREAR (no existen todavía): ${resumen.crear.length}`);
  console.log(`Se van a COMPLETAR (existen pero sin ingredientes, ej. Manhattan/Caipiriña): ${resumen.yaExistenVacios.length}`);
  console.log(`YA EXISTEN con ingredientes cargados — se OMITEN, no se tocan: ${resumen.yaExistenConDatos.length}`);
  console.log('');

  const imprimirGrupo = (titulo, lista) => {
    console.log(`--- ${titulo} (${lista.length}) ---`);
    lista.forEach(it => {
      console.log(`  ${it.nombre} (${it.categoria})`);
      it.ingredientesMatch.forEach(i => {
        if (i.match) console.log(`    ✔ ${i.nombreIng} (${i.cantidad}${i.unidad}) → matchea con "${i.match.nombre}" (precio: ${i.match.precio_unitario ?? '(sin precio)'})`);
        else console.log(`    ✘ ${i.nombreIng} (${i.cantidad}${i.unidad}) → SIN MATCH, no se va a cargar este ingrediente`);
      });
    });
    console.log('');
  };

  imprimirGrupo('A CREAR', resumen.crear);
  imprimirGrupo('A COMPLETAR (existentes vacíos)', resumen.yaExistenVacios);

  if (resumen.yaExistenConDatos.length) {
    console.log(`--- YA EXISTEN CON DATOS, se omiten (${resumen.yaExistenConDatos.length}) ---`);
    resumen.yaExistenConDatos.forEach(it => console.log(`  ${it.nombre} → ya es el trago #${it.platoId} con ${it.ingredientesActuales} ingrediente(s) cargado(s)`));
    console.log('');
  }

  const totalSinMatch = [...resumen.crear, ...resumen.yaExistenVacios].reduce((acc, it) => acc + it.sinMatch.length, 0);
  console.log(`⚠ Total de ingredientes SIN match en todo el lote: ${totalSinMatch} (van a quedar afuera de la receta, agregalos a mano después si hace falta)`);
  console.log('');

  if (!ejecutar) {
    console.log('MODO PRUEBA — no se cambió nada todavía.');
    console.log('Si el reporte se ve bien, correr de nuevo así:');
    console.log('  node cargar_recetas_worksheet.js --ejecutar');
    process.exit(0);
  }

  // ── Ejecutar ──
  for (const it of [...resumen.crear, ...resumen.yaExistenVacios]) {
    let platoId = it.platoId;
    if (!platoId) {
      const nuevo = await db.run2(
        `INSERT INTO platos_costo (nombre, categoria, porciones, departamento) VALUES ($1,$2,1,'ayb') RETURNING id`,
        [it.nombre, it.categoria]
      );
      platoId = nuevo.lastID || nuevo.rows?.[0]?.id;
    }
    let costoTotal = 0;
    for (const ing of it.ingredientesMatch) {
      if (!ing.match) continue;
      const costoParcial = (parseFloat(ing.cantidad) || 0) * (parseFloat(ing.match.precio_unitario) || 0);
      costoTotal += costoParcial;
      await db.run2(
        `INSERT INTO plato_insumos_ayb (plato_id, insumo_id, cantidad, unidad, costo_parcial) VALUES ($1,$2,$3,$4,$5)`,
        [platoId, ing.match.id, ing.cantidad, ing.unidad, costoParcial]
      );
    }
    await db.run2(`UPDATE platos_costo SET costo_total=$1 WHERE id=$2`, [costoTotal, platoId]);
    console.log(`✔ ${it.nombre} → trago #${platoId}, costo total: $${costoTotal.toFixed(2)}`);
  }

  console.log('');
  console.log('Listo. Los ingredientes sin match no se cargaron — revisalos en el reporte de arriba y agregalos a mano si hace falta.');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
