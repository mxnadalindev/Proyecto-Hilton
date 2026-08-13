// 007_recoff_pendiente.js
// Agrega usuarios.recoff_pendiente — el contador de francos compensatorios
// que se le deben a cada empleado. Se resta solo cuando se le carga un día
// de RECOFF en la grilla (Personal u Horarios), y se puede sumar a mano
// cuando corresponda que se le sume un día adeudado.
//
// Uso: node 007_recoff_pendiente.js   (desde la raíz del proyecto)
// Seguro de correr más de una vez.

const db = require('./src/db/database');

(async () => {
  try {
    await db.run2(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS recoff_pendiente INTEGER DEFAULT 0`);
    console.log('✓ Listo — usuarios.recoff_pendiente creado (o ya existía).');
  } catch (e) {
    console.error('✗ Error:', e.message);
  } finally {
    process.exit(0);
  }
})();
