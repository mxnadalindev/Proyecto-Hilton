-- Catálogo de productos de A&B, para que el lector de código de barras
-- pueda autocompletar nombre/unidad de un producto ya conocido.
-- Independiente de croutons_lotes (que sigue siendo el registro de cada
-- lote físico que entra con su fecha de vencimiento).
CREATE TABLE IF NOT EXISTS productos_ayb (
  id SERIAL PRIMARY KEY,
  codigo_barras TEXT UNIQUE,
  nombre TEXT NOT NULL,
  categoria TEXT DEFAULT 'General',
  unidad_default TEXT DEFAULT 'unidad',
  creado_en TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_productos_ayb_codigo ON productos_ayb (codigo_barras);
