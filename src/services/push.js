// Envío de notificaciones push reales (las que llegan aunque el navegador
// esté cerrado, como una notificación de WhatsApp). Usa el protocolo Web
// Push estándar — funciona en Chrome/Edge/Firefox en cualquier SO, y en
// Safari/iOS 16.4+ si el sitio se agregó a la pantalla de inicio como PWA.
const webpush = require('web-push');
const db = require('../db/database');

let configurado = false;

function asegurarConfiguracion() {
  if (configurado) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    'mailto:sistemas@hilton-ba.example', // contacto de referencia, no se usa para nada más
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  configurado = true;
  return true;
}

// Manda el mismo aviso a TODAS las suscripciones activas DE UN CANAL
// específico (ej: 'croutons') — así alguien que activó avisos desde otro
// módulo (por ejemplo "Mi disponibilidad") no recibe notificaciones que no
// le corresponden. El canal es obligatorio a propósito: si algún día se
// llama sin especificarlo, mejor no mandar nada a que se mande a quien no
// corresponde por error.
async function enviarATodos({ titulo, cuerpo, url, canal }) {
  if (!canal) {
    console.warn('enviarATodos: falta indicar "canal" — no se manda nada, para no arriesgar mandarle a quien no corresponde.');
    return { enviados: 0, fallidos: 0, configurado: true, error: 'falta_canal' };
  }
  if (!asegurarConfiguracion()) {
    console.warn('Push no configurado: faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en el .env');
    return { enviados: 0, fallidos: 0, configurado: false };
  }

  const suscripciones = await db.all2('SELECT * FROM push_subscriptions WHERE canal = $1', [canal]);
  const payload = JSON.stringify({ title: titulo, body: cuerpo, url: url || '/croutons' });

  let enviados = 0, fallidos = 0;

  for (const sub of suscripciones) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      enviados++;
    } catch (e) {
      fallidos++;
      // 404/410 = la suscripción ya no existe del lado del navegador — la limpiamos
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db.run2('DELETE FROM push_subscriptions WHERE id=$1', [sub.id]).catch(() => {});
      } else {
        console.error('Error enviando push a', sub.endpoint.slice(0, 50), '...', e.message);
      }
    }
  }

  return { enviados, fallidos, configurado: true };
}

module.exports = { enviarATodos, asegurarConfiguracion };
