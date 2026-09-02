-- Corrección de nombres dudosos importados en el catálogo de Croutons.
-- Correr el SELECT primero y confirmar que el texto coincide antes del UPDATE
-- (si no coincide exacto, el UPDATE de abajo no va a afectar ninguna fila).

SELECT id, nombre, categoria FROM productos_ayb
WHERE nombre ILIKE '%rodehisia%' OR nombre ILIKE '%coloread%';

UPDATE productos_ayb SET nombre = 'Mini Rodesia' WHERE nombre = 'Mini Rodehisia';
UPDATE productos_ayb SET categoria = 'General' WHERE nombre = 'Coloreada';

-- Por si ya hay lotes cargados con el nombre viejo, para que también se corrijan:
UPDATE croutons_lotes SET producto = 'Mini Rodesia' WHERE producto = 'Mini Rodehisia';
