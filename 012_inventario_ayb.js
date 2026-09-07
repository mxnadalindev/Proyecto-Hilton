// 012_inventario_ayb.js
// Inventario AYB — módulo de stock de productos de barra, separado de
// Croutons (que sigue siendo solo vencimientos). Reusa productos_ayb (que
// ya existía pero no se usaba en ningún lado) sumándole stock_actual y
// activo, y agrega inventario_ayb_movimientos como historial de cambios.
//
// Nota: esto mismo se crea solo al arrancar el portal (server.js requiere
// database.js, que corre estos ALTER/CREATE en su init()). Este script
// queda como respaldo para correrlo a mano en una base que ya está arriba,
// sin tener que reiniciar el servidor.
//
// Uso: node 012_inventario_ayb.js   (desde la raíz del proyecto)
// Seguro de correr más de una vez.

const db = require('./src/db/database');

(async () => {
  try {
    await db.run2(`ALTER TABLE productos_ayb ADD COLUMN IF NOT EXISTS stock_actual REAL DEFAULT 0`);
    await db.run2(`ALTER TABLE productos_ayb ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT true`);
    console.log('✓ productos_ayb: columnas stock_actual/activo listas.');

    await db.run2(`
      CREATE TABLE IF NOT EXISTS inventario_ayb_movimientos (
        id SERIAL PRIMARY KEY,
        producto_id INTEGER NOT NULL REFERENCES productos_ayb(id) ON DELETE CASCADE,
        tipo TEXT NOT NULL,
        cantidad REAL NOT NULL,
        cantidad_anterior REAL,
        cantidad_nueva REAL,
        nota TEXT,
        usuario_id INTEGER REFERENCES usuarios(id),
        usuario_nombre TEXT,
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✓ Tabla inventario_ayb_movimientos creada (o ya existía).');

    await db.run2(`CREATE INDEX IF NOT EXISTS idx_inventario_ayb_mov_producto ON inventario_ayb_movimientos (producto_id, creado_en DESC)`);
    console.log('✓ Índice de movimientos creado (o ya existía).');
  } catch (e) {
    console.error('✗ Error:', e.message);
  } finally {
    process.exit(0);
  }
})();
