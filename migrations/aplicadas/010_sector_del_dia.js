// 010_sector_del_dia.js
// Agrega horarios_semanales.sector_dia — permite asignar a un cocinero a
// OTRO sector por un solo día, sin tocar su sector general (el que sigue
// usando Horarios para agruparlo).
//
// Uso: node 010_sector_del_dia.js   (desde la raíz del proyecto)

const db = require('./src/db/database');

(async () => {
  try {
    await db.run2(`ALTER TABLE horarios_semanales ADD COLUMN IF NOT EXISTS sector_dia TEXT`);
    console.log('✓ Listo — horarios_semanales.sector_dia creado (o ya existía).');
  } catch (e) {
    console.error('✗ Error:', e.message);
  } finally {
    process.exit(0);
  }
})();
