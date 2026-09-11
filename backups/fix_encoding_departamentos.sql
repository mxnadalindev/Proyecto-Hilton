-- Arregla la codificacion de tildes en la columna "departamento" de usuarios.
-- No borra ni inventa datos: normaliza el TEXTO de los valores existentes
-- (ej. "Panadería" con una variante de codificacion de la tilde) a la forma
-- estandar NFC, que es la que usa el codigo del programa para comparar.
-- Es idempotente: correrlo mas de una vez no hace nada raro.

-- Antes del arreglo: cuantos iguales hay por bytes vs por texto visible
SELECT departamento, count(*),
       departamento = normalize(departamento, NFC) AS ya_estaba_bien
FROM usuarios
WHERE departamento IS NOT NULL AND departamento <> ''
GROUP BY departamento, (departamento = normalize(departamento, NFC))
ORDER BY departamento;

-- El arreglo en si
UPDATE usuarios
SET departamento = normalize(departamento, NFC)
WHERE departamento IS NOT NULL
  AND departamento <> normalize(departamento, NFC);

-- Verificacion final: ahora esto deberia dar 42
SELECT count(*) AS total_deberia_ver_ahora
FROM usuarios
WHERE departamento = ANY(ARRAY[
    'Supervisores','Comis de Recepción','Panadería',
    'Pastelería AM','Pastelería PM','Faro AM','Faro PM',
    'Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'
  ])
  AND LOWER(rol) != 'admin';
