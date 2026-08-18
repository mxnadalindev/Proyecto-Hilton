-- Calendario de feriados: solo un marcador visual, independiente de los
-- estados por empleado. No asigna nada automáticamente a nadie.
CREATE TABLE IF NOT EXISTS feriados (
  fecha DATE PRIMARY KEY,
  nombre TEXT NOT NULL
);
