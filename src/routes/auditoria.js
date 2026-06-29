// Helper para registrar acciones en la tabla auditoria
const db = require('../db/database');

async function registrar(req, accion, detalle = '') {
  try {
    const usuario = req.session?.usuario;
    const ip = req.ip || req.connection?.remoteAddress || '—';
    await db.run2(
      'INSERT INTO auditoria (usuario_id, usuario_nombre, accion, detalle, ip) VALUES ($1, $2, $3, $4, $5)',
      [usuario?.id || null, usuario?.nombre || 'Sistema', accion, detalle, ip]
    );
  } catch(e) {
    console.error('Error auditoría:', e.message);
  }
}

module.exports = { registrar };
