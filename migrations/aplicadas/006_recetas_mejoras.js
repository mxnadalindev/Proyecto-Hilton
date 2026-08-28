// 006_recetas_mejoras.js
// - Renombra la columna "pasos" a "procedimiento" (conserva los datos).
// - Agrega "ingredientes_json" (estructurado: nombre/cantidad/precio_unitario).
// - Crea receta_videos (múltiples videos por receta, clasificados).
// - Migra el video_url existente de cada receta (si tenía) a receta_videos,
//   para no perder nada de lo ya cargado.
//
// Uso: node 006_recetas_mejoras.js   (desde la raíz del proyecto)
// Seguro de correr más de una vez.

const db = require('./src/db/database');

async function main() {
  console.log('=== Migración 006 — Recetas ===\n');

  // 1) Renombrar pasos -> procedimiento (si "pasos" todavía existe)
  const tienePasos = await db.get2(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name='recetas' AND column_name='pasos'
  `);
  if (tienePasos) {
    console.log('1) Renombrando "pasos" -> "procedimiento"...');
    await db.run2(`ALTER TABLE recetas RENAME COLUMN pasos TO procedimiento`);
  } else {
    console.log('1) "procedimiento" ya existe, no hace falta renombrar.');
  }

  // 2) Ingredientes estructurados
  console.log('2) Agregando columna ingredientes_json...');
  await db.run2(`ALTER TABLE recetas ADD COLUMN IF NOT EXISTS ingredientes_json JSONB`);

  // 3) Tabla de videos múltiples
  console.log('3) Creando receta_videos...');
  await db.run2(`
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

  // 4) Migrar video_url viejo (una receta, un video) a la tabla nueva, sin duplicar si ya se migró
  const tieneVideoUrl = await db.get2(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name='recetas' AND column_name='video_url'
  `);
  if (tieneVideoUrl) {
    console.log('4) Migrando videos existentes (video_url) a receta_videos...');
    const recetasConVideo = await db.all2(`SELECT id, video_url FROM recetas WHERE video_url IS NOT NULL AND video_url <> ''`);
    for (const r of recetasConVideo) {
      const yaMigrado = await db.get2(`SELECT 1 FROM receta_videos WHERE receta_id=$1 AND valor=$2`, [r.id, r.video_url]);
      if (yaMigrado) continue;
      const esUrl = /^https?:\/\//i.test(r.video_url);
      await db.run2(
        `INSERT INTO receta_videos (receta_id, clasificacion, origen, valor) VALUES ($1,'Otros',$2,$3)`,
        [r.id, esUrl ? 'url' : 'archivo', r.video_url]
      );
    }
    console.log(`   ${recetasConVideo.length} receta(s) con video revisada(s).`);
  }

  console.log('\n✓ Listo — migración de Recetas completa.');
  process.exit(0);
}

main().catch(e => {
  console.error('\n✗ Error en la migración:', e.message);
  console.error(e);
  process.exit(1);
});
