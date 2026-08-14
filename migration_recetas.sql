-- ============================================================
-- Migración: ingredientes reales (desde insumos) + fotos clasificadas
-- Ejecutar UNA SOLA VEZ contra la base de datos existente.
-- No borra nada de lo que ya tenés, solo agrega tablas nuevas.
-- ============================================================

-- Ingredientes de la receta, ahora como referencia real a "insumos"
-- (antes se guardaban como texto libre en recetas.ingredientes_json)
CREATE TABLE IF NOT EXISTS receta_insumos (
  id SERIAL PRIMARY KEY,
  receta_id INTEGER NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
  insumo_id INTEGER NOT NULL REFERENCES insumos(id),
  cantidad NUMERIC NOT NULL DEFAULT 0,
  unidad TEXT
);

-- Fotos de la receta, clasificadas igual que los videos
-- (Preparación / Montaje / Otros). La receta sigue teniendo su
-- "imagen" de portada aparte — esto es la galería clasificada.
CREATE TABLE IF NOT EXISTS receta_fotos (
  id SERIAL PRIMARY KEY,
  receta_id INTEGER NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
  clasificacion TEXT NOT NULL DEFAULT 'Otros',
  archivo TEXT NOT NULL,
  orden INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_receta_insumos_receta ON receta_insumos(receta_id);
CREATE INDEX IF NOT EXISTS idx_receta_insumos_insumo ON receta_insumos(insumo_id);
CREATE INDEX IF NOT EXISTS idx_receta_fotos_receta   ON receta_fotos(receta_id);

-- Nota: la columna vieja recetas.ingredientes_json queda intacta como
-- respaldo histórico de las recetas cargadas antes de este cambio.
-- El código nuevo ya no escribe ahí ni la usa para calcular costos.
