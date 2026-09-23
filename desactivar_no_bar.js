// desactivar_no_bar.js
//
// Qué hace: revisa los productos activos de Inventario AYB y, comparándolos
// contra la lista de ~139 productos del Bar (código de ubicación "220" del
// sistema de inventario del hotel), DESACTIVA (activo = false) los que NO
// están en esa lista — nunca los borra, así se pueden reactivar después.
//
// Uso:
//   1) Primero, SIEMPRE correr en modo de prueba (no cambia nada):
//        node desactivar_no_bar.js
//      Esto imprime un reporte completo: cuáles quedan activos, cuáles se
//      desactivarían, y qué productos de la lista del Bar no se encontraron
//      cargados en el portal. Revisar ese reporte con calma ANTES de ejecutar.
//
//   2) Si el reporte se ve bien, recién ahí ejecutar de verdad:
//        node desactivar_no_bar.js --ejecutar
//
// Cómo matchea: primero por código de barras (si el producto lo tiene
// cargado, comparándolo contra el "Item Code" de la lista del Bar). Si el
// producto no tiene código de barras cargado, se intenta por nombre exacto
// (ignorando mayúsculas/minúsculas, acentos y espacios de más). Lo que no
// matchea de ninguna de las dos formas queda como candidato a desactivar —
// se lista completo en el reporte para que se pueda revisar a mano antes de
// confirmar.

const db = require('./src/db/database');
const listaBar = require('./codigos_bar_220.json'); // [ [codigo, nombre], ... ]

function normalizar(s) {
  return (s || '')
    .toString()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca acentos
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const ejecutar = process.argv.includes('--ejecutar');

(async () => {
  const codigosBarSet = new Set(listaBar.map(([codigo]) => codigo.trim()));
  const nombresBarSet = new Set(listaBar.map(([, nombre]) => normalizar(nombre)));

  const productos = await db.all2('SELECT id, nombre, codigo_barras, categoria, activo FROM productos_ayb WHERE activo = true ORDER BY nombre');

  const quedanActivos = [];
  const candidatosDesactivar = [];

  for (const p of productos) {
    const cod = (p.codigo_barras || '').trim();
    const nombreNorm = normalizar(p.nombre);
    const matcheaPorCodigo = cod && codigosBarSet.has(cod);
    const matcheaPorNombre = !cod && nombresBarSet.has(nombreNorm);
    if (matcheaPorCodigo || matcheaPorNombre) {
      quedanActivos.push(p);
    } else {
      candidatosDesactivar.push(p);
    }
  }

  // Códigos de la lista del Bar que no se encontraron entre los productos activos del portal
  const codigosEncontrados = new Set(
    quedanActivos.map(p => (p.codigo_barras || '').trim()).filter(Boolean)
  );
  const nombresEncontrados = new Set(quedanActivos.map(p => normalizar(p.nombre)));
  const faltantesEnPortal = listaBar.filter(([codigo, nombre]) =>
    !codigosEncontrados.has(codigo.trim()) && !nombresEncontrados.has(normalizar(nombre))
  );

  console.log('====================================================');
  console.log('REPORTE — Inventario AYB vs. lista del Bar (código 220)');
  console.log('====================================================');
  console.log(`Total productos activos en el portal: ${productos.length}`);
  console.log(`Productos de la lista del Bar: ${listaBar.length}`);
  console.log('');
  console.log(`✔ Quedan ACTIVOS (matchean con la lista del Bar): ${quedanActivos.length}`);
  console.log(`✘ Candidatos a DESACTIVAR (no matchean): ${candidatosDesactivar.length}`);
  console.log(`⚠ Productos de la lista del Bar que NO se encontraron cargados en el portal: ${faltantesEnPortal.length}`);
  console.log('');

  if (faltantesEnPortal.length) {
    console.log('--- Productos del Bar que no están cargados en el portal (revisar si hace falta cargarlos) ---');
    faltantesEnPortal.forEach(([codigo, nombre]) => console.log(`  [${codigo}] ${nombre}`));
    console.log('');
  }

  console.log('--- Candidatos a desactivar (primeros 30 de ' + candidatosDesactivar.length + ') ---');
  candidatosDesactivar.slice(0, 30).forEach(p => {
    console.log(`  #${p.id} ${p.nombre} | cód: ${p.codigo_barras || '(sin código)'} | categoría: ${p.categoria || '(sin categoría)'}`);
  });
  if (candidatosDesactivar.length > 30) {
    console.log(`  ... y ${candidatosDesactivar.length - 30} más (ver reporte completo en desactivar_no_bar_reporte.json)`);
  }
  console.log('');

  // Guarda el reporte completo en un archivo, para poder revisarlo entero
  const fs = require('fs');
  fs.writeFileSync('./desactivar_no_bar_reporte.json', JSON.stringify({
    quedanActivos, candidatosDesactivar, faltantesEnPortal
  }, null, 2));
  console.log('Reporte completo guardado en desactivar_no_bar_reporte.json');
  console.log('');

  if (!ejecutar) {
    console.log('MODO PRUEBA — no se cambió nada todavía.');
    console.log('Si el reporte de arriba se ve bien, correr de nuevo así:');
    console.log('  node desactivar_no_bar.js --ejecutar');
    process.exit(0);
  }

  if (candidatosDesactivar.length === 0) {
    console.log('No hay nada para desactivar.');
    process.exit(0);
  }

  console.log(`Desactivando ${candidatosDesactivar.length} productos...`);
  const ids = candidatosDesactivar.map(p => p.id);
  // Actualiza de a lotes para no mandar una query gigante
  const TAMANO_LOTE = 200;
  for (let i = 0; i < ids.length; i += TAMANO_LOTE) {
    const lote = ids.slice(i, i + TAMANO_LOTE);
    const placeholders = lote.map((_, idx) => `$${idx + 1}`).join(',');
    await db.run2(`UPDATE productos_ayb SET activo = false WHERE id IN (${placeholders})`, lote);
  }
  console.log('Listo. Esos productos quedaron desactivados (no se borró nada, se pueden reactivar editándolos).');
  process.exit(0);
})().catch(e => {
  console.error('ERROR:', e);
  process.exit(1);
});
