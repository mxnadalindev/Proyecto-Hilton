// 009_indice_recoff.js
// Agrega un índice específico para la consulta que cuenta cuántos RECOFF
// tiene puestos cada empleado (se usa en Personal y en Horarios, en cada
// carga de página). Sin esto, esa consulta revisa toda la tabla
// horarios_semanales entera cada vez — con el tiempo se pone lenta.
//
// Uso: node 009_indice_recoff.js   (desde la raíz del proyecto)
// Seguro de correr más de una vez.

const db = require('./src/db/database');

(async () => {
  try {
    await db.run2(`
      CREATE INDEX IF NOT EXISTS idx_horarios_semanales_recoff
      ON horarios_semanales (usuario_id)
      WHERE UPPER(valor) = 'RECOFF'
    `);
    console.log('✓ Índice de RECOFF creado (o ya existía).');

    await db.run2(`
      CREATE INDEX IF NOT EXISTS idx_horarios_semanales_fecha
      ON horarios_semanales (fecha)
    `);
    console.log('✓ Índice de fecha creado (o ya existía) — acelera la carga del rango visible en Personal y Horarios.');
  } catch (e) {
    console.error('✗ Error:', e.message);
  } finally {
    process.exit(0);
  }
})();
