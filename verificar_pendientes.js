// verificar_pendientes.js — SOLO LECTURA, no cambia nada.
//
// Muestra qué tragos de Costos (AYB) siguen en $0 después de cargar la
// planilla, para confirmar si "Manhattan"/"Caipiriña" (u otros) quedaron
// sin tocar por tener un "primo" con nombre parecido que ya tenía datos
// (ej. "Bourbon Manhattan", "Caipirinha" sin ñ).
//
// Uso:
//   node verificar_pendientes.js

const db = require('./src/db/database');

(async () => {
  const pendientes = await db.all2(
    "SELECT id, nombre, costo_total FROM platos_costo WHERE departamento='ayb' AND (costo_total IS NULL OR costo_total = 0) ORDER BY nombre"
  );

  console.log('====================================================');
  console.log('Tragos (AYB) todavía en $0');
  console.log('====================================================');
  console.log(`Total: ${pendientes.length}`);
  pendientes.forEach(t => console.log(`  #${t.id} ${t.nombre}`));

  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
