// src/services/whatsapp.js
//
// Todavía no hay una cuenta de WhatsApp Business conectada (Maxi la está
// gestionando) — mientras tanto, "enviar" un WhatsApp significa dejarlo
// cargado en whatsapp_outbox para que alguien lo mande a mano con el link
// wa.me de esa fila (ver la pantalla de Configuración > WhatsApp
// pendientes, mismo patrón wa.me que ya se usa en Horarios de AYB). No se
// marca enviado=true acá — eso queda reservado para cuando un humano lo
// mandó de verdad (o, el día de mañana, para cuando la API real confirme
// el envío).
//
// El día que haya una API real conectada, alcanza con cambiar el ADENTRO
// de enviarWhatsApp() por la llamada real — nadie que la llama en el resto
// del código (horarios.js, escalamientoAyb.js) necesita cambiar nada.

const db = require('../db/database');

async function enviarWhatsApp(numero, mensaje, invitacionId = null) {
  try {
    await db.run2(
      `INSERT INTO whatsapp_outbox (destinatario_celular, mensaje, invitacion_id) VALUES ($1,$2,$3)`,
      [numero || null, mensaje, invitacionId]
    );
    return { ok: true };
  } catch (e) {
    console.error('Error encolando WhatsApp:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { enviarWhatsApp };
