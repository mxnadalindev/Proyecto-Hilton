BEGIN;

ALTER TABLE usuarios
ADD COLUMN IF NOT EXISTS departamento VARCHAR(50);

ALTER TABLE usuarios
ADD CONSTRAINT chk_departamento
CHECK (departamento IN ('cocina', 'compras', 'ayb', 'finanzas') OR departamento IS NULL);

CREATE INDEX IF NOT EXISTS idx_usuarios_departamento ON usuarios(departamento);

COMMIT;
