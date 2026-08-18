// 011_inventario_ayb.js
// Crea la tabla de inventario/stock de Alimentos y Bebidas — nombre, cantidad,
// vencimiento, proveedor y stock mínimo (para poder avisar cuando hay que
// pedir), tal como se definió al planificar el módulo.
//
// Uso: node 011_inventario_ayb.js   (desde la raíz del proyecto)

const db = require('./src/db/database');

(async () => {
  try {
    await db.run2(`
      CREATE TABLE IF NOT EXISTS inventario_ayb (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        categoria TEXT DEFAULT 'General',
        cantidad REAL NOT NULL DEFAULT 0,
        unidad TEXT DEFAULT 'unidad',
        stock_minimo REAL DEFAULT 0,
        proveedor TEXT,
        fecha_vencimiento DATE,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.run2(`
      CREATE INDEX IF NOT EXISTS idx_inventario_ayb_vencimiento
      ON inventario_ayb (fecha_vencimiento)
    `);
    console.log('✓ Listo — inventario_ayb creada (o ya existía).');
  } catch (e) {
    console.error('✗ Error:', e.message);
  } finally {
    process.exit(0);
  }
})();
