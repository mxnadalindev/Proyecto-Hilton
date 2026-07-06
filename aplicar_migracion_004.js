// Script de migración — agrega la columna "codigo" a insumos.
// Uso: node aplicar_migracion_004.js   (correr desde la raíz del proyecto)
const db = require('./src/db/database');

(async () => {
  try {
    await db.run2(`
      ALTER TABLE insumos
      ADD COLUMN IF NOT EXISTS codigo VARCHAR(50)
    `);
    await db.run2(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_insumos_codigo_unico
      ON insumos (codigo)
      WHERE codigo IS NOT NULL
    `);
    console.log('Listo — columna "codigo" agregada a insumos (con índice único).');
  } catch (e) {
    console.error('Error aplicando la migración:', e.message);
  } finally {
    process.exit(0);
  }
})();
