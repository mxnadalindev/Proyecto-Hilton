// src/services/whatsapp.js
//
// Todavía no hay una cuenta de WhatsApp Business (la API OFICIAL de Meta)
// conectada — Maxi la está gestionando pero no quiere esperar a eso para
// tener envíos automáticos ya. Mientras tanto, "enviar" un WhatsApp
// significa:
//   1) Intentar mandarlo YA, de verdad, por el puente de número personal
//      (ver src/services/whatsappPersonal.js — Baileys, WhatsApp Web,
//      NO es la API oficial, ver el comentario grande en ese archivo).
//   2) Si ese intento falla (no hay nadie vinculado todavía, se cortó la
//      conexión justo en ese momento, WhatsApp rechazó el envío, etc.),
//      cae al comportamiento de siempre: quedar cargado en whatsapp_outbox
//      para que alguien lo mande a mano con el link wa.me de esa fila (ver
//      la pantalla de Configuración > WhatsApp pendientes, mismo patrón
//      wa.me que ya se usa en Horarios de AYB).
//
// En los dos casos la fila en whatsapp_outbox queda igual de creada —
// sirve como historial/auditoría de todo lo que el sistema intentó mandar,
// se haya podido mandar solo o no. Lo único que cambia es enviado/enviado_en.
//
// El día que haya una API oficial de WhatsApp Business conectada, alcanza
// con agregar un tercer intento acá (antes o en vez del de
// whatsappPersonal) — nadie que llama a enviarWhatsApp() en el resto del
// código (horarios.js, escalamientoAyb.js) necesita cambiar nada, la firma
// de la función no se toca.

const db = require('../db/database');
const { enviarPorWhatsappPersonal } = require('./whatsappPersonal');

async function enviarWhatsApp(numero, mensaje, invitacionId = null) {
  try {
    const fila = await db.get2(
      `INSERT INTO whatsapp_outbox (destinatario_celular, mensaje, invitacion_id) VALUES ($1,$2,$3) RETURNING id`,
      [numero || null, mensaje, invitacionId]
    );

    // Intento de envío real por el número personal vinculado (Baileys). Si
    // no hay nadie conectado (el caso más común mientras Maxi no vinculó
    // ningún número, o mientras se está reconectando) esto tira una
    // excepción a propósito — se atrapa acá mismo y la fila queda tal cual
    // quedaba antes: enviado=false, esperando que un humano la mande a
    // mano. Un fallo acá NUNCA debe tirar abajo a quien llamó a
    // enviarWhatsApp() (escalamientoAyb.js corre en un setInterval de
    // fondo sin nadie mirando la consola en el momento).
    try {
      await enviarPorWhatsappPersonal(numero, mensaje);
      await db.run2(`UPDATE whatsapp_outbox SET enviado=true, enviado_en=NOW() WHERE id=$1`, [fila.id]);
    } catch (eEnvio) {
      // No es un error del sistema, es el camino esperado cuando todavía
      // no hay (o no hay ahora mismo) un WhatsApp personal vinculado — no
      // se loguea como console.error para no ensuciar la consola en cada
      // convocatoria mientras Maxi no vinculó nada.
      console.log(`WhatsApp a ${numero || '(sin celular)'} quedó pendiente de envío manual: ${eEnvio.message}`);
    }

    return { ok: true };
  } catch (e) {
    console.error('Error encolando WhatsApp:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { enviarWhatsApp };
