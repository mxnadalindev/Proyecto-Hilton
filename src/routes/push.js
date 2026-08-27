const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');
const { enviarATodos } = require('../services/push');

router.use(loginRequerido);

// El frontend pide esto para saber con qué clave pública armar la suscripción
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

// Guarda la suscripción de este navegador/dispositivo, para un canal
// específico (ej: 'croutons') — así solo recibe avisos de ese módulo.
router.post('/suscribir', async (req, res) => {
  const { endpoint, keys, canal } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ ok: false, error: 'Suscripción incompleta.' });
  }
  if (!canal) {
    return res.status(400).json({ ok: false, error: 'Falta indicar el canal.' });
  }
  try {
    await db.run2(
      `INSERT INTO push_subscriptions (usuario_id, endpoint, p256dh, auth, canal)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET usuario_id=$1, p256dh=$3, auth=$4, canal=$5`,
      [req.session.usuario.id, endpoint, keys.p256dh, keys.auth, canal]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Error guardando suscripción push:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Saca la suscripción de este navegador (cuando el usuario apaga los avisos)
router.post('/desuscribir', async (req, res) => {
  const { endpoint } = req.body || {};
  try {
    if (endpoint) await db.run2('DELETE FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Botón "mandar aviso de prueba" — útil para confirmar que todo el circuito
// funciona antes de depender de que el bot lo dispare automáticamente.
router.post('/prueba', async (req, res) => {
  const canal = req.body?.canal || 'croutons';
  const resultado = await enviarATodos({
    titulo: 'Aviso de prueba',
    cuerpo: `${req.session.usuario.nombre} probó las notificaciones — si ves esto, están funcionando.`,
    url: '/croutons',
    canal,
  });
  res.json(resultado);
});

module.exports = router;
