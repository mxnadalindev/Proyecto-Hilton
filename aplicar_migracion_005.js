// Script de migración — crea las tablas menus y menu_platos.
// Uso: node aplicar_migracion_005.js   (correr desde la raíz del proyecto)
const db = require('./src/db/database');

(async () => {
  try {
    await db.run2(`
      CREATE TABLE IF NOT EXISTS menus (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        descripcion TEXT,
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.run2(`
      CREATE TABLE IF NOT EXISTS menu_platos (
        id SERIAL PRIMARY KEY,
        menu_id INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
        plato_id INTEGER NOT NULL REFERENCES platos_costo(id) ON DELETE CASCADE,
        cantidad_porciones INTEGER DEFAULT 1
      )
    `);
    console.log('Listo — tablas "menus" y "menu_platos" creadas.');
  } catch (e) {
    console.error('Error aplicando la migración:', e.message);
  } finally {
    process.exit(0);
  }
})();
