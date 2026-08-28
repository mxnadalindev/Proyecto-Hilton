BEGIN;

INSERT INTO usuarios (nombre, email, password, rol, departamento, activo)
VALUES
  ('Usuario Demo Compras',  'test@hilton.com',  '$2b$12$IZ0h6BkqdztS4Skw7gK3K.UPBBx0lJYVkIlT8mS7dWGC.tKnpvtV2', 'empleado', 'compras',  1),
  ('Usuario Demo AyB',      'test1@hilton.com', '$2b$12$IZ0h6BkqdztS4Skw7gK3K.UPBBx0lJYVkIlT8mS7dWGC.tKnpvtV2', 'empleado', 'ayb',      1),
  ('Usuario Demo Finanzas', 'test2@hilton.com', '$2b$12$IZ0h6BkqdztS4Skw7gK3K.UPBBx0lJYVkIlT8mS7dWGC.tKnpvtV2', 'empleado', 'finanzas', 1)
ON CONFLICT (email) DO UPDATE
  SET departamento = EXCLUDED.departamento,
      password = EXCLUDED.password,
      activo = 1;

COMMIT;
