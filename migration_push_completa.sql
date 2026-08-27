-- Guarda las "suscripciones" de cada dispositivo/navegador que activó los
-- avisos push. Un mismo usuario puede tener varias (celular + compu), por
-- eso no es un campo en "usuarios" sino una tabla aparte.
-- El campo "canal" aísla los avisos por módulo (ej: 'croutons') — así una
-- suscripción hecha desde una pantalla nunca recibe avisos de otra.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  canal TEXT NOT NULL DEFAULT 'croutons',
  creado_en TIMESTAMP DEFAULT NOW()
);
