// src/db/database.js — PostgreSQL
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// La contraseña se puede sobreescribir con DB_PASSWORD en el .env — si no
// está seteada, usa la misma de siempre por default, así no rompe nada en
// las instalaciones existentes. Importante: antes esto se imprimía en la
// consola con cada arranque del servidor (contraseña en texto plano en los
// logs) — se sacó ese console.log a propósito, es información sensible.
const DBPASS = process.env.DB_PASSWORD || 'hilton2026';
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'hilton_db',
  user: process.env.DB_USER || 'hilton_user',
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

  // La columna "departamento" se usa para DOS cosas distintas: el código de
  // departamento de acceso al portal ('cocina'/'ayb'/'compras'/'finanzas')
  // en cuentas de login, y el SECTOR puntual (p.ej. 'Panadería', 'Bar') en
  // los empleados cargados desde Personal. La migración vieja
  // (001_add_departamento.sql) le puso un CHECK que solo permitía los 4
  // códigos de departamento — eso rompe silenciosamente el alta de
  // cualquier empleado con un sector real (INSERT rechazado por el CHECK).
  // Si esa migración se corrió en alguna de las dos PCs, esto la saca sola,
  // sin tocar los datos existentes.
  await pool.query(`ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS chk_departamento`);

  // Los mozos eventuales/de agencia casi nunca tienen un email de Hilton —
  // el email deja de ser obligatorio (se puede loguear con el CUIL, guardado
  // en "legajo"). UNIQUE en Postgres permite múltiples NULL sin problema.
  await pool.query(`ALTER TABLE usuarios ALTER COLUMN email DROP NOT NULL`);

  // "modalidad": cómo trabaja un mozo de AYB — Eventual / Fijo / Agencia.
  // Es un concepto distinto al "sector" de Cocina, por eso es una columna
  // aparte en vez de reusar "departamento" (que para AYB ahora se deja
  // siempre en 'ayb', ya no se pisa con nombres de sector como pasaba antes).
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS modalidad TEXT`);

  // "fecha_alta": desde cuándo está activo un mozo eventual de AYB. La
  // modalidad "Eventual" tiene un límite real de contrato de 6 meses desde
  // esta fecha — la usamos para avisarle al encargado cuando se acerca el
  // vencimiento, en vez de que se entere tarde. Para los mozos que ya
  // estaban cargados antes de esta columna no tenemos forma de saber la
  // fecha real, así que queda NULL (sin aviso) hasta que el encargado la
  // cargue a mano en "Miembro de equipo"; los que se cargan de acá en más
  // (a mano, por CSV o por foto) la reciben automáticamente en el momento del alta.
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS fecha_alta DATE`);
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS celular TEXT`);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auditoria (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id),
      usuario_nombre TEXT,
      accion TEXT NOT NULL,
      detalle TEXT,
      ip TEXT,
      creado_en TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS configuracion_sistema (
      clave TEXT PRIMARY KEY,
      valor TEXT
    )
  `);
  await pool.query(`
    INSERT INTO configuracion_sistema (clave, valor) VALUES
      ('max_intentos_login', '5'),
      ('tiempo_bloqueo_min', '15'),
      ('sesion_horas', '8'),
      ('forzar_cambio_password', 'false')
    ON CONFLICT (clave) DO NOTHING
  `);

  // horarios_semanales: la usan Personal, Horarios y el Asistente todo el
  // tiempo (RECOFF, estados como VAC/LIBRE/ART, horarios por día) pero,
  // igual que auditoria/configuracion_sistema, nunca se creaba en ningún
  // lado del código — entrar a Personal u Horarios tiraba el servidor
  // abajo apenas hubiera algo cargado. UNIQUE (usuario_id, fecha) porque
  // las rutas hacen "ON CONFLICT (usuario_id, fecha) DO UPDATE".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS horarios_semanales (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      fecha DATE NOT NULL,
      valor TEXT,
      sector_dia TEXT,
      UNIQUE (usuario_id, fecha)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_horarios_semanales_recoff
    ON horarios_semanales (usuario_id)
    WHERE UPPER(valor) = 'RECOFF'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_horarios_semanales_fecha
    ON horarios_semanales (fecha)
  `);

  // feriados: Personal ya tiene las rutas para cargarlos y borrarlos (con
  // try/catch, así que no tiraba el servidor abajo como las otras), pero
  // sin esta tabla la función simplemente no funcionaba — el "marcado de
  // feriados en un calendario" que la bitácora del proyecto lista como
  // pendiente en realidad ya estaba codificado, solo faltaba la tabla.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feriados (
      fecha DATE PRIMARY KEY,
      nombre TEXT NOT NULL
    )
  `);

  // disponibilidad: calendario de "Disponibilidad" en Personal — carga por
  // día si un empleado está disponible o no (p.ej. para armar los turnos
  // de Alimentos y Bebidas). Guardado disperso: solo existe una fila cuando
  // alguien cargó explícitamente Disponible/No disponible ese día; sin
  // fila = sin dato, igual que feriados y horarios_semanales.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS disponibilidad (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      fecha DATE NOT NULL,
      disponible BOOLEAN NOT NULL,
      UNIQUE (usuario_id, fecha)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_disponibilidad_usuario_fecha ON disponibilidad (usuario_id, fecha)`);

  // Franja horaria del día disponible: "hora_desde" con hora fija, y
  // "hora_hasta" opcional — si queda vacío significa "a partir de esa hora,
  // sin límite" (así lo pidieron: puede ser rango completo o solo un piso).
  await pool.query(`ALTER TABLE disponibilidad ADD COLUMN IF NOT EXISTS hora_desde TEXT`);
  await pool.query(`ALTER TABLE disponibilidad ADD COLUMN IF NOT EXISTS hora_hasta TEXT`);

  // eventos_ayb: eventos que carga el encargado/admin de A&B (nombre, horario,
  // cupo de mozos necesarios) dentro del mismo almanaque de Horarios. Los
  // mozos se anotan hasta llenar el cupo; "oculto" lo usa el encargado para
  // sacarlo de la vista de los mozos una vez cubierto, sin borrar el evento.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS eventos_ayb (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      fecha DATE NOT NULL,
      hora_desde TEXT NOT NULL,
      hora_hasta TEXT,
      cupo INTEGER NOT NULL,
      oculto BOOLEAN NOT NULL DEFAULT false,
      creado_por INTEGER REFERENCES usuarios(id),
      creado_en TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_eventos_ayb_fecha ON eventos_ayb (fecha)`);

  // eventos_ayb_inscripciones: quién se anotó a cada evento. Un mozo no
  // puede anotarse dos veces al mismo evento (UNIQUE).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS eventos_ayb_inscripciones (
      id SERIAL PRIMARY KEY,
      evento_id INTEGER NOT NULL REFERENCES eventos_ayb(id) ON DELETE CASCADE,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      inscrito_en TIMESTAMP DEFAULT NOW(),
      UNIQUE (evento_id, usuario_id)
    )
  `);

  // "asistio": marca de asistencia real, separada de "se anotó". NULL =
  // todavía sin marcar (el evento no pasó, o el encargado no lo marcó
  // después), true = vino, false = faltó. La carga el encargado/admin de
  // AYB después del evento, desde la lista de anotados.
  await pool.query(`ALTER TABLE eventos_ayb_inscripciones ADD COLUMN IF NOT EXISTS asistio BOOLEAN`);

  // receta_fotos y receta_insumos: igual que con auditoria/configuracion_sistema,
  // el código de src/routes/recetas.js ya las usa (incluso en el listado
  // principal de /recetas, en la subconsulta de imagen de portada) pero
  // nunca se creaban en ningún lado — sin esto, entrar a /recetas rompía
  // el servidor entero apenas hubiera una sola receta con foto.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS receta_fotos (
      id SERIAL PRIMARY KEY,
      receta_id INTEGER NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
      clasificacion TEXT NOT NULL DEFAULT 'Otros',
      archivo TEXT NOT NULL,
      orden INTEGER DEFAULT 0,
      creado_en TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS receta_insumos (
      id SERIAL PRIMARY KEY,
      receta_id INTEGER NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
      insumo_id INTEGER NOT NULL REFERENCES insumos(id),
      cantidad REAL DEFAULT 0,
      unidad TEXT
    )
  `);

  // Insumos — código de producto (antes migración 004 aparte): columna
  // opcional pero única cuando está cargada, para poder buscar/matchear
  // insumos por código de proveedor sin duplicados.
  await pool.query(`ALTER TABLE insumos ADD COLUMN IF NOT EXISTS codigo VARCHAR(50)`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_insumos_codigo_unico
    ON insumos (codigo)
    WHERE codigo IS NOT NULL
  `);

  // Menús (antes migración 005 aparte): agrupan varios platos de Costos en
  // un combo/menú armado, con su cantidad de porciones por plato.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS menus (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      descripcion TEXT,
      creado_en TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS menu_platos (
      id SERIAL PRIMARY KEY,
      menu_id INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
      plato_id INTEGER NOT NULL REFERENCES platos_costo(id) ON DELETE CASCADE,
      cantidad_porciones INTEGER DEFAULT 1
    )
  `);

  // Recetas — mejoras (antes migración 006 aparte): "pasos" pasa a llamarse
  // "procedimiento" (se conserva el contenido si ya tenía), se suma
  // ingredientes_json para el formato estructurado, y receta_videos permite
  // varios videos por receta en vez de uno solo. El video_url viejo (si
  // había) se migra una sola vez a la tabla nueva, sin duplicar en cada
  // arranque.
  const recetasPasos = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name='recetas' AND column_name='pasos'
  `);
  if (recetasPasos.rows.length) {
    await pool.query(`ALTER TABLE recetas RENAME COLUMN pasos TO procedimiento`);
  }
  await pool.query(`ALTER TABLE recetas ADD COLUMN IF NOT EXISTS ingredientes_json JSONB`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS receta_videos (
      id SERIAL PRIMARY KEY,
      receta_id INTEGER NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
      clasificacion TEXT NOT NULL DEFAULT 'Otros',
      origen TEXT NOT NULL,
      valor TEXT NOT NULL,
      titulo TEXT,
      orden INTEGER DEFAULT 0,
      creado_en TIMESTAMP DEFAULT NOW()
    )
  `);
  const recetasVideoUrl = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name='recetas' AND column_name='video_url'
  `);
  if (recetasVideoUrl.rows.length) {
    const conVideo = await pool.query(`SELECT id, video_url FROM recetas WHERE video_url IS NOT NULL AND video_url <> ''`);
    for (const r of conVideo.rows) {
      const yaMigrado = await pool.query(`SELECT 1 FROM receta_videos WHERE receta_id=$1 AND valor=$2`, [r.id, r.video_url]);
      if (yaMigrado.rows.length) continue;
      const esUrl = /^https?:\/\//i.test(r.video_url);
      await pool.query(
        `INSERT INTO receta_videos (receta_id, clasificacion, origen, valor) VALUES ($1,'Otros',$2,$3)`,
        [r.id, esUrl ? 'url' : 'archivo', r.video_url]
      );
    }
  }

  // usuarios.recoff_adeudado (antes migraciones 007+008 aparte): días de
  // franco compensatorio que se le deben a cada empleado. Se llamó
  // "recoff_pendiente" en un primer momento; si una base vieja todavía
  // tiene esa columna con ese nombre, se renombra en vez de duplicar.
  const recoffViejo = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name='usuarios' AND column_name='recoff_pendiente'
  `);
  if (recoffViejo.rows.length) {
    await pool.query(`ALTER TABLE usuarios RENAME COLUMN recoff_pendiente TO recoff_adeudado`);
  } else {
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS recoff_adeudado INTEGER DEFAULT 0`);
  }

  // "Admin general" (acceso a Backups/Auditoría completa/reasignar
  // departamentos) ya NO depende de que la cuenta no tenga departamento
  // asignado — antes esos dos conceptos estaban pegados al mismo campo
  // "departamento", así que un admin no podía a la vez estar "scopeado" a
  // su sector (para que Personal/Horarios no le mezclen otros sectores) Y
  // tener acceso general a Configuración. Con esta columna separada, un
  // admin puede tener departamento='cocina' (ve solo Cocina en
  // Personal/Horarios) y es_admin_general=true (ve todo en Configuración)
  // al mismo tiempo — son dos cosas independientes.
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS es_admin_general BOOLEAN NOT NULL DEFAULT false`);

  // Alimentos y Bebidas — Croutons: cada fila es un LOTE (una entrada de
  // mercadería), no un producto único. Así, si llega una entrega nueva de
  // croutons mientras todavía queda stock viejo, conviven dos filas con
  // vencimientos distintos, en vez de pisar la fecha del lote anterior.
  await pool.query(`
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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_croutons_lotes_vencimiento
    ON croutons_lotes (fecha_vencimiento)
    WHERE estado = 'activo'
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
