-- Agrega el motivo por el que se marcó un lote como consumido
-- (Vencido / Rotura-daño / Uso normal / Otro).
ALTER TABLE croutons_lotes ADD COLUMN IF NOT EXISTS motivo_consumo TEXT;
