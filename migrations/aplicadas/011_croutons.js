// 011_croutons.js
// Crea croutons_lotes — módulo de Alimentos y Bebidas para cargar mercadería
// de croutons con su fecha de vencimiento, y detectar productos que vencen
// dentro de 15 días o ya vencidos.
//
// Nota: esta misma tabla ya se crea sola al arrancar el portal (server.js
// requiere database.js, que corre este CREATE TABLE IF NOT EXISTS en su
// init()). Este script queda como respaldo para correrlo a mano en una base
// que ya está arriba, sin tener que reiniciar el servidor.
//
// Uso: node 011_croutons.js   (desde la raíz del proyecto)
// Seguro de correr más de una vez.

const db = require('./src/db/database');

(async () => {
  try {
    await db.run2(`
      CREATE TABLE IF NOT EXISTS croutons_lotes (
        id SERIAL PRIMARY KEY,
        producto TEXT NOT NULL,
        cantidad REAL DEFAULT 0,
        unidad TEXT DEFAULT 'kg',
        proveedor TEXT,
        lote_proveedor TEXT,
        fecha_ingreso DATE DEFAULT CURRENT_DATE,
        fecha_vencimiento DATE NOT NULL,
        notas TEXT,
        estado TEXT DEFAULT 'activo',
        creado_por INTEGER REFERENCES usuarios(id),
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✓ Tabla croutons_lotes creada (o ya existía).');

    await db.run2(`
      CREATE INDEX IF NOT EXISTS idx_croutons_lotes_vencimiento
      ON croutons_lotes (fecha_vencimiento)
      WHERE estado = 'activo'
    `);
    console.log('✓ Índice de vencimiento creado (o ya existía).');
  } catch (e) {
    console.error('✗ Error:', e.message);
  } finally {
    process.exit(0);
  }
})();
