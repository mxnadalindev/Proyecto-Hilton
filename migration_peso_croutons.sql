-- Separa "cuántos bultos entraron" (cantidad + unidad = caja/paquete/bolsa/
-- unidad suelta) de "cuánto pesa o mide" (peso + unidad_peso = kg/g/lt/ml).
-- Antes venía todo mezclado en un solo campo "unidad", confundiendo cajas
-- con kilos. Los dos son opcionales — un almacén puede cargar un lote
-- contando solo bultos, solo peso, o ambos.
ALTER TABLE croutons_lotes
  ADD COLUMN IF NOT EXISTS peso REAL,
  ADD COLUMN IF NOT EXISTS unidad_peso TEXT DEFAULT 'kg';
