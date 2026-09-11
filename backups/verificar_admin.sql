-- Datos de la cuenta admin@hilton.com: con que "departamento" esta cargada
SELECT id, nombre, email, rol, departamento FROM usuarios WHERE email='admin@hilton.com';

-- Cuantos empleados de Cocina deberia ver esa cuenta segun la logica del sistema
SELECT count(*) AS total_deberia_ver
FROM usuarios
WHERE departamento = ANY(ARRAY[
    'Supervisores','Comis de Recepción','Panadería',
    'Pastelería AM','Pastelería PM','Faro AM','Faro PM',
    'Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'
  ])
  AND LOWER(rol) != 'admin';
