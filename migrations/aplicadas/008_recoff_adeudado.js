// 008_recoff_adeudado.js
// Renombra usuarios.recoff_pendiente -> recoff_adeudado.
// A partir de ahora ese número representa "días que se le deben" (se carga
// a mano con +/-), y el pendiente real que se muestra en pantalla se
// calcula siempre en vivo como: adeudado - RECOFF ya puestos en la grilla.
// Así no importa en qué orden se haya cargado cada cosa.
//
// Uso: node 008_recoff_adeudado.js   (desde la raíz del proyecto)

const db = require('./src/db/database');

(async () => {
  try {
    const tieneViejo = await db.get2(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name='usuarios' AND column_name='recoff_pendiente'
    `);
    if (tieneViejo) {
      await db.run2(`ALTER TABLE usuarios RENAME COLUMN recoff_pendiente TO recoff_adeudado`);
      console.log('✓ Renombrado recoff_pendiente -> recoff_adeudado.');
    } else {
      await db.run2(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS recoff_adeudado INTEGER DEFAULT 0`);
      console.log('✓ recoff_adeudado creado (o ya existía).');
    }
  } catch (e) {
    console.error('✗ Error:', e.message);
  } finally {
    process.exit(0);
  }
})();
