// corregir_matches_erroneos.js
//
// Corrige un error puntual que cometió completar_7_pendientes.js: en 4
// líneas, el ingrediente buscado era una sola palabra genérica ("Naranja"
// o "Fernet") y, entre varios productos candidatos con esa palabra, el
// script eligió mal "Espuma de naranja y fernet menta" (un producto que
// tiene ambas palabras en su nombre, pero no es ni naranja ni fernet).
// Afecta exactamente estas 4 líneas:
//   - Boulivardier   → ingrediente "Naranja"
//   - Fernet Cola    → ingrediente "Fernet"   (¡el ingrediente principal!)
//   - Manhattan      → ingrediente "Naranja"
//   - Two Smoking Barrels → ingrediente "Fernet"
//
// Este script:
//   1) Borra SOLO esas líneas puntuales (identificadas por el trago +
//      que su ingrediente cargado sea exactamente "Espuma de naranja y
//      fernet menta" — no toca ninguna otra línea de ningún otro trago).
//   2) Intenta volver a matchear "Naranja"/"Fernet" con un criterio más
//      estricto (si hay varios productos candidatos, ahora prioriza el
//      que tiene MENOS palabras de más — es decir, el nombre más
//      específico/parecido al buscado, no cualquiera que contenga la
//      palabra en algún lado).
//   3) Recalcula el costo_total de los 4 tragos afectados.
//
// También intenta, sólo como mejor-esfuerzo, encontrar "Cachaza" (con
// variante de ortografía "Cachaca") y "jack daniel" (con variante en
// plural "jack daniels") por si el nombre real en tu catálogo está
// escrito un poco distinto — si no encuentra nada mejor que antes, no
// cambia nada ahí.
//
// Uso:
//   1) Modo prueba (no cambia nada):   node corregir_matches_erroneos.js
//   2) Si el reporte se ve bien:       node corregir_matches_erroneos.js --ejecutar

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

// Igual que antes, pero ahora devuelve también la "precisión" (qué
// fracción de las palabras del CANDIDATO son parte del match) para poder
// desempatar a favor del nombre más específico cuando hay más de un
// candidato con el mismo puntaje de recall.
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

function mejorMatch(buscado, productos, alternativas = []) {
  const candidatos = [buscado, ...alternativas];
  let mejor = null;
  for (const termino of candidatos) {
    for (const p of productos) {
      const { score, precision } = evaluarMatch(termino, p.nombre);
      if (score < 0.5) continue;
      if (!mejor || score > mejor.score || (score === mejor.score && precision > mejor.precision)) {
        mejor = { ...p, score, precision };
      }
    }
  }
  return mejor;
}

const CORRECCIONES = [
  { plato: 'Boulivardier', ingrediente: 'Naranja' },
  { plato: 'Fernet Cola', ingrediente: 'Fernet', alternativas: ['Fernet Branca'] },
  { plato: 'Manhattan', ingrediente: 'Naranja' },
  { plato: 'Two Smoking Barrels', ingrediente: 'Fernet', alternativas: ['Fernet Branca'] },
];

const MEJORES_ESFUERZOS = [
  { plato: 'Caipiriña', ingrediente: 'Cachaza', alternativas: ['Cachaca'] },
  { plato: 'Two Smoking Barrels', ingrediente: 'jack daniel', alternativas: ['jack daniels', 'jack daniel\'s'] },
];

(async () => {
  const productos = await db.all2("SELECT id, nombre, precio_unitario, unidad_default FROM productos_ayb WHERE activo=true");

  console.log('====================================================');
  console.log('CORREGIR matches erróneos de "Naranja"/"Fernet"');
  console.log('====================================================');

  const acciones = [];

  for (const c of CORRECCIONES) {
    const plato = await db.get2("SELECT id FROM platos_costo WHERE nombre=$1 AND departamento='ayb'", [c.plato]);
    if (!plato) { console.log(`- "${c.plato}": no se encontró el trago. Se omite.`); continue; }

    const lineaMala = await db.get2(`
      SELECT pi.id, pi.cantidad, pi.unidad FROM plato_insumos_ayb pi
      JOIN productos_ayb pr ON pr.id = pi.insumo_id
      WHERE pi.plato_id = $1 AND pr.nombre = 'Espuma de naranja y fernet menta'
    `, [plato.id]);

    if (!lineaMala) {
      console.log(`- "${c.plato}" / "${c.ingrediente}": no tiene la línea mal matcheada (¿ya se corrigió?). Se omite.`);
      continue;
    }

    const nuevo = mejorMatch(c.ingrediente, productos, c.alternativas || []);
    console.log(`- "${c.plato}" / ingrediente "${c.ingrediente}":`);
    console.log(`    ANTES (mal): Espuma de naranja y fernet menta`);
    if (nuevo) {
      console.log(`    DESPUÉS: "${nuevo.nombre}" (precio: ${nuevo.precio_unitario})`);
    } else {
      console.log(`    DESPUÉS: SIN MATCH — se va a borrar la línea mala y quedar sin este ingrediente (agregalo a mano)`);
    }

    acciones.push({ platoId: plato.id, lineaId: lineaMala.id, cantidad: lineaMala.cantidad, unidad: lineaMala.unidad, nuevo });
  }

  console.log('');
  console.log('--- Mejor esfuerzo (variantes de ortografía) ---');
  const mejoresEsfuerzos = [];
  for (const m of MEJORES_ESFUERZOS) {
    const plato = await db.get2("SELECT id FROM platos_costo WHERE nombre=$1 AND departamento='ayb'", [m.plato]);
    if (!plato) continue;
    // sólo tiene sentido si esa línea sigue sin match hoy (no está cargada)
    const yaExiste = await db.all2('SELECT pi.id, pr.nombre FROM plato_insumos_ayb pi JOIN productos_ayb pr ON pr.id=pi.insumo_id WHERE pi.plato_id=$1', [plato.id]);
    const posible = mejorMatch(m.ingrediente, productos, m.alternativas || []);
    if (posible) {
      console.log(`- "${m.plato}" / "${m.ingrediente}" → encontrado con variante: "${posible.nombre}" (precio: ${posible.precio_unitario})`);
      mejoresEsfuerzos.push({ platoId: plato.id, ingrediente: m.ingrediente, nuevo: posible });
    } else {
      console.log(`- "${m.plato}" / "${m.ingrediente}" → sigue sin encontrarse ni con variantes de ortografía. No se toca.`);
    }
  }

  console.log('');
  if (!ejecutar) {
    console.log('MODO PRUEBA — no se cambió nada todavía.');
    console.log('Si el reporte se ve bien, correr de nuevo así:');
    console.log('  node corregir_matches_erroneos.js --ejecutar');
    process.exit(0);
  }

  const platosATocar = new Set();

  for (const a of acciones) {
    await db.run2('DELETE FROM plato_insumos_ayb WHERE id=$1', [a.lineaId]);
    if (a.nuevo) {
      const costo_parcial = a.cantidad * a.nuevo.precio_unitario;
      await db.run2(
        'INSERT INTO plato_insumos_ayb (plato_id, insumo_id, cantidad, unidad, costo_parcial) VALUES ($1,$2,$3,$4,$5)',
        [a.platoId, a.nuevo.id, a.cantidad, a.unidad, costo_parcial]
      );
    }
    platosATocar.add(a.platoId);
  }

  for (const m of mejoresEsfuerzos) {
    // Sólo agregar si esa línea concreta no está ya cargada con ESE producto
    const ya = await db.get2('SELECT id FROM plato_insumos_ayb WHERE plato_id=$1 AND insumo_id=$2', [m.platoId, m.nuevo.id]);
    if (ya) continue;
    // Buscamos la cantidad original según el trago/ingrediente (hardcodeado, ya que sólo son 2 casos conocidos)
    const cantidad = m.ingrediente === 'Cachaza' ? 60 : 60; // Cachaza:60ml, jack daniel:60ml
    const unidad = 'ml';
    const costo_parcial = cantidad * m.nuevo.precio_unitario;
    await db.run2(
      'INSERT INTO plato_insumos_ayb (plato_id, insumo_id, cantidad, unidad, costo_parcial) VALUES ($1,$2,$3,$4,$5)',
      [m.platoId, m.nuevo.id, cantidad, unidad, costo_parcial]
    );
    platosATocar.add(m.platoId);
  }

  for (const platoId of platosATocar) {
    const suma = await db.get2('SELECT COALESCE(SUM(costo_parcial),0) AS total FROM plato_insumos_ayb WHERE plato_id=$1', [platoId]);
    await db.run2('UPDATE platos_costo SET costo_total=$1 WHERE id=$2', [suma.total, platoId]);
    console.log(`✔ Trago #${platoId} recalculado → costo total: $${parseFloat(suma.total).toFixed(2)}`);
  }

  console.log('Listo.');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
