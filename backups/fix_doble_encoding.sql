-- Arregla el DOBLE-encoding UTF-8 de la columna "departamento" (y de paso
-- "nombre" y "puesto", por si tienen el mismo problema en algún caso).
-- El texto quedó guardado como si los bytes UTF-8 originales se hubieran
-- vuelto a interpretar como Latin1 y re-codificado a UTF-8 — por eso
-- "Panadería" quedó como "PanaderÃ­a". Se revierte con
-- convert_from(convert_to(texto, 'LATIN1'), 'UTF8'), que es matemáticamente
-- lo opuesto de lo que pasó. Solo toca las filas que tienen el patrón de
-- corrupción (contienen 'Ã'), así que es seguro correrlo aunque algunas
-- filas ya estén bien.

-- Antes del arreglo: cuáles filas están afectadas
SELECT id, nombre, departamento
FROM usuarios
WHERE departamento LIKE '%Ã%' OR nombre LIKE '%Ã%' OR puesto LIKE '%Ã%';

-- El arreglo
UPDATE usuarios
SET departamento = convert_from(convert_to(departamento, 'LATIN1'), 'UTF8')
WHERE departamento LIKE '%Ã%';

UPDATE usuarios
SET nombre = convert_from(convert_to(nombre, 'LATIN1'), 'UTF8')
WHERE nombre LIKE '%Ã%';

UPDATE usuarios
SET puesto = convert_from(convert_to(puesto, 'LATIN1'), 'UTF8')
WHERE puesto LIKE '%Ã%';

-- Verificación: ahora debería dar 42
SELECT count(*) AS total_deberia_ver_ahora
FROM usuarios
WHERE departamento = ANY(ARRAY[
    'Supervisores','Comis de Recepción','Panadería',
    'Pastelería AM','Pastelería PM','Faro AM','Faro PM',
    'Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'
  ])
  AND LOWER(rol) != 'admin';

-- Lista final de departamentos, para confirmar visualmente que ya no hay 'Ã'
SELECT DISTINCT departamento FROM usuarios WHERE departamento IS NOT NULL ORDER BY departamento;
