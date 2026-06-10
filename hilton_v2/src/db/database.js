// src/db/database.js
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../../data/hilton.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Rendimiento
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Crear tablas ──────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    rol TEXT DEFAULT 'empleado',
    activo INTEGER DEFAULT 1,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    fecha TEXT NOT NULL,
    hora_inicio TEXT,
    hora_fin TEXT,
    descripcion TEXT,
    cantidad_personal INTEGER DEFAULT 0,
    horas_produccion REAL DEFAULT 0,
    costo_total REAL DEFAULT 0,
    creado_por INTEGER,
    creado_en TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (creado_por) REFERENCES usuarios(id)
  );

  CREATE TABLE IF NOT EXISTS evento_platos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id INTEGER NOT NULL,
    plato_nombre TEXT NOT NULL,
    cantidad_porciones INTEGER DEFAULT 1,
    costo_porcion REAL DEFAULT 0,
    subtotal REAL DEFAULT 0,
    FOREIGN KEY (evento_id) REFERENCES eventos(id)
  );

  CREATE TABLE IF NOT EXISTS evento_personal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id INTEGER NOT NULL,
    usuario_id INTEGER NOT NULL,
    FOREIGN KEY (evento_id) REFERENCES eventos(id),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  );

  CREATE TABLE IF NOT EXISTS evento_vajilla (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id INTEGER NOT NULL,
    vajilla_nombre TEXT NOT NULL,
    cantidad INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS recetas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    categoria TEXT,
    ingredientes TEXT,
    pasos TEXT,
    video_url TEXT,
    imagen TEXT,
    area TEXT,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS precios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto TEXT NOT NULL,
    precio REAL DEFAULT 0,
    categoria TEXT,
    actualizado_en TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── Admin por defecto ─────────────────────────────────
const adminExiste = db.prepare("SELECT id FROM usuarios WHERE email = ?").get('admin@hilton.com');
if (!adminExiste) {
  const hash = bcrypt.hashSync('hilton2026', 10);
  db.prepare("INSERT INTO usuarios (nombre, email, password, rol) VALUES (?, ?, ?, ?)").run(
    'Administrador', 'admin@hilton.com', hash, 'admin'
  );
  console.log('✓ Usuario admin creado: admin@hilton.com / hilton2026');
}

module.exports = db;
