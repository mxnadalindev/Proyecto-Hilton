// src/utils/red.js
//
// Encuentra la IP de la red local de la PC donde corre el portal (la
// misma que server.js ya mostraba en la consola al arrancar como "Red
// local: usar en celulares") — para poder armarla en cualquier lado del
// código que necesite un link que un CELULAR pueda abrir, no solo esta PC.
//
// Por qué hace falta esto: "http://localhost:5000/..." SOLO funciona
// abierto desde la misma PC donde corre el servidor — un celular que
// abre ese link literalmente busca "localhost" en SU PROPIO celular, no
// en la PC del portal, así que nunca carga nada (ni siquiera da un error
// claro: muchas apps, WhatsApp incluido, ni siquiera lo muestran como un
// link tocable porque "localhost" no tiene punto ni terminación de
// dominio). Los links de invitación por WhatsApp (ver
// escalamientoAyb.js) tienen que poder abrirse desde el celular del
// mozo, así que necesitan la IP de red local (algo como
// "192.168.0.15"), no "localhost".
const os = require('os');

function getIpsLocales() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        ips.push(alias.address);
      }
    }
  }
  return ips;
}

// Arma la URL base que hay que usar para links pensados para abrirse
// desde OTRO dispositivo (celulares) — no desde esta misma PC. Prioridad:
//   1) PORTAL_URL en el .env, si Maxi la cargó a mano (por ejemplo el día
//      que el portal tenga un dominio público real, o si prefiere fijar
//      una IP en particular).
//   2) La primera IP de red local que encuentre esta PC.
//   3) Si por lo que sea no encuentra ninguna (PC sin red, rarísimo),
//      cae a localhost como último recurso — funciona mal en celulares
//      pero al menos no rompe nada para quien esté en la misma PC.
function urlBaseParaCelulares(port) {
  if (process.env.PORTAL_URL) return process.env.PORTAL_URL;
  const [ip] = getIpsLocales();
  if (ip) return `http://${ip}:${port}`;
  return `http://localhost:${port}`;
}

module.exports = { getIpsLocales, urlBaseParaCelulares };
