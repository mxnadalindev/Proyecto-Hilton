-- Para la papelera de "Consumidos": guarda CUÁNDO se marcó cada lote como
-- consumido, así se puede mostrar "hace cuántos días" y calcular cuándo
-- se borra solo (a los 30 días).
ALTER TABLE croutons_lotes
  ADD COLUMN IF NOT EXISTS consumido_en TIMESTAMP;
