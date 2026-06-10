// src/db/database.js — PostgreSQL
const { Pool } = require('pg');
console.log('DB PASS TYPE:', typeof 'hilton2026', '| VALUE:', 'hilton2026');
const bcrypt = require('bcryptjs');

const DBPASS = 'hilton2026';
console.log('POOL PASS:', DBPASS, typeof DBPASS);
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'hilton_db',
  user: 'hilton_user',
  password: DBPASS,
});

// Helpers — misma interfaz que antes para no tocar las rutas
const db = {
  run2: async (sql, params = []) => {
    const res = await pool.query(sql, params);
    return { lastID: res.rows[0]?.id, changes: res.rowCount };
  },
  get2: async (sql, params = []) => {
    const res = await pool.query(sql, params);
    return res.rows[0] || null;
  },
  all2: async (sql, params = []) => {
    const res = await pool.query(sql, params);
    return res.rows;
  },
};

const init = async () => {
  console.log('Conectando a PostgreSQL...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      legajo TEXT,
      puesto TEXT DEFAULT 'Cocinero',
      rol TEXT DEFAULT 'empleado',
      activo INTEGER DEFAULT 1,
      creado_en TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS eventos (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      fecha TEXT NOT NULL,
      hora_inicio TEXT,
      hora_fin TEXT,
      descripcion TEXT,
      cantidad_personal INTEGER DEFAULT 0,
      horas_produccion REAL DEFAULT 0,
      costo_total REAL DEFAULT 0,
      creado_por INTEGER REFERENCES usuarios(id),
      creado_en TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS evento_platos (
      id SERIAL PRIMARY KEY,
      evento_id INTEGER NOT NULL REFERENCES eventos(id),
      plato_nombre TEXT NOT NULL,
      cantidad_porciones INTEGER DEFAULT 1,
      costo_porcion REAL DEFAULT 0,
      subtotal REAL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS evento_personal (
      id SERIAL PRIMARY KEY,
      evento_id INTEGER NOT NULL REFERENCES eventos(id),
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS evento_vajilla (
      id SERIAL PRIMARY KEY,
      evento_id INTEGER NOT NULL REFERENCES eventos(id),
      vajilla_nombre TEXT NOT NULL,
      cantidad INTEGER DEFAULT 1
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recetas (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      categoria TEXT,
      ingredientes TEXT,
      pasos TEXT,
      video_url TEXT,
      imagen TEXT,
      area TEXT,
      creado_en TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS horarios (
      id SERIAL PRIMARY KEY,
      fecha TEXT NOT NULL,
      evento_id INTEGER REFERENCES eventos(id),
      turno TEXT NOT NULL,
      hora_inicio TEXT NOT NULL,
      hora_fin TEXT NOT NULL,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      estado TEXT DEFAULT 'asignado',
      creado_en TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS horario_config (
      id SERIAL PRIMARY KEY,
      fecha TEXT NOT NULL,
      evento_id INTEGER REFERENCES eventos(id),
      turno TEXT NOT NULL,
      cantidad_necesaria INTEGER DEFAULT 1,
      creado_en TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS insumos (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      categoria TEXT DEFAULT 'General',
      unidad TEXT DEFAULT 'kg',
      precio_unitario REAL DEFAULT 0,
      stock_actual REAL DEFAULT 0,
      proveedor TEXT,
      actualizado_en TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platos_costo (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      categoria TEXT,
      porciones INTEGER DEFAULT 1,
      precio_venta REAL DEFAULT 0,
      margen_ganancia REAL DEFAULT 30,
      costo_total REAL DEFAULT 0,
      creado_en TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plato_insumos (
      id SERIAL PRIMARY KEY,
      plato_id INTEGER NOT NULL REFERENCES platos_costo(id),
      insumo_id INTEGER NOT NULL REFERENCES insumos(id),
      cantidad REAL DEFAULT 0,
      unidad TEXT,
      costo_parcial REAL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS historial_precios (
      id SERIAL PRIMARY KEY,
      insumo_id INTEGER NOT NULL REFERENCES insumos(id),
      precio_anterior REAL DEFAULT 0,
      precio_nuevo REAL DEFAULT 0,
      fecha TIMESTAMP DEFAULT NOW(),
      origen TEXT DEFAULT 'manual'
    )
  `);

  // Admin por defecto
  const admin = await db.get2(
    "SELECT id FROM usuarios WHERE email = $1", ['admin@hilton.com']
  );
  if (!admin) {
    const hash = bcrypt.hashSync('hilton2026', 10);
    await pool.query(
      "INSERT INTO usuarios (nombre, email, password, rol, puesto) VALUES ($1,$2,$3,$4,$5)",
      ['Administrador', 'admin@hilton.com', hash, 'admin', 'Administrativo']
    );
    console.log('✓ Admin creado: admin@hilton.com / hilton2026');
  }

  console.log('✓ PostgreSQL listo');
};

init().catch(err => {
  console.error('Error iniciando DB:', err.message);
  process.exit(1);
});

module.exports = db;
