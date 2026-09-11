-- Verifica si los "departamento" de los empleados de cocina coinciden
-- exactamente con los sectores que usa la pantalla de Horarios.
-- Si esto devuelve filas para cada sector (con la cantidad correcta),
-- el dato esta bien guardado y el problema es otra cosa.
-- Si devuelve 0 filas o le faltan sectores, hay un problema de codificacion
-- de caracteres (tildes) en lo que se inserto.
SELECT departamento, count(*) AS cantidad
FROM usuarios
WHERE activo = 1
  AND departamento = ANY(ARRAY[
    'Supervisores','Comis de Recepción','Panadería',
    'Pastelería AM','Pastelería PM','Faro AM','Faro PM',
    'Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'
  ])
GROUP BY departamento
ORDER BY departamento;

-- Cuantos empleados de cocina hay en total, sin filtrar por el nombre exacto del sector
SELECT count(*) AS total_deberia_aparecer_en_horarios
FROM usuarios
WHERE activo = 1
  AND departamento NOT IN ('ayb','compras','finanzas','cocina')
  AND departamento IS NOT NULL
  AND departamento <> '';
