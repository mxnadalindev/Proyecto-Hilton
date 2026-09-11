// src/services/whatsappPersonal.js
//
// ─────────────────────────────────────────────────────────────────────────
// OJO — ESTO NO ES LA API OFICIAL DE WHATSAPP BUSINESS (Meta). Maxi todavía
// no tiene esa cuenta dada de alta y no quiere esperar, así que esto es un
// "puente" que usa Baileys (@whiskeysockets/baileys) para manejar un
// WhatsApp Web con un número de WhatsApp PERSONAL (el de Maxi, o cualquier
// otro que termine escaneando el QR) como si fuera un dispositivo vinculado
// más (Configuración > Dispositivos vinculados en el teléfono). No hay
// aprobación de Meta de por medio, ni plantillas de mensaje, ni nada de
// eso — es la cuenta de una persona mandando mensajes automáticos.
//
// Maxi ya entiende y acepta que WhatsApp puede llegar a banear/limitar ese
// número por mandar mensajes automatizados (no es el uso "normal" de la
// app) — no hace falta re-advertirle desde la UI. Pero para quien toque
// este código después (Maxi mismo, u otro dev): el día que se dé de alta
// la API oficial de WhatsApp Business, ESTO se reemplaza por completo, no
// se "mejora" — son dos cosas conceptualmente distintas (un número
// personal emulando un cliente de WhatsApp Web vs. una cuenta de negocio
// verificada por Meta con su propia infra de envío).
// ─────────────────────────────────────────────────────────────────────────
//
// Qué hace este módulo:
//  - Arranca (o reconecta) un socket de Baileys al iniciar el server.
//  - Guarda las credenciales de la sesión en disco (SESSION_DIR) para no
//    tener que volver a escanear el QR en cada reinicio del server — mismo
//    criterio que uploads/ o backups/ en este proyecto: datos que se
//    generan en la PC donde corre el portal, no código fuente, así que van
//    afuera de git (ver .gitignore) y no viajan en un zip de la app.
//  - Expone el estado actual (desconectado / esperando_qr / conectado) y,
//    mientras espera que lo escaneen, el QR ya renderizado como PNG en
//    base64 — para que Configuración lo pueda mostrar sin que la vista
//    tenga que saber nada de Baileys.
//  - Expone enviarPorWhatsappPersonal(numero, mensaje) para que
//    whatsapp.js intente el envío real cuando hay conexión, y
//    desvincularWhatsapp() para que un admin pueda cerrar sesión y volver
//    a vincular otro número.

const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

// Misma carpeta "data/" para todo lo que sea estado persistente propio del
// puente de WhatsApp (por ahora solo la sesión) — separada de uploads/
// (archivos que suben los usuarios) y backups/ (dumps de la base).
const SESSION_DIR = path.join(__dirname, '../../data/whatsapp_session');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// Logger en 'silent': Baileys por default es MUY verboso en consola
// (loguea básicamente cada paquete del protocolo) — eso taparía el resto
// de los logs del portal. Los errores que sí nos importan se loguean acá
// mismo, a mano, con console.error.
const logger = pino({ level: 'silent' });

let sock = null;
let estado = 'desconectado'; // 'desconectado' | 'esperando_qr' | 'conectado'
let qrDataUrl = null; // PNG en base64 (data URL) del QR vigente, o null
let numeroConectado = null; // número de WhatsApp ya conectado (si estado==='conectado')
let reintentoTimer = null;

function getEstadoWhatsapp() {
  return { estado, qr: qrDataUrl, numero: numeroConectado };
}

// El JID de un contacto individual en Baileys es "<código país + número, solo
// dígitos>@s.whatsapp.net" (ver README de Baileys, sección "Whatsapp IDs
// Explain"). El resto del portal guarda los celulares como texto libre sin
// código de país (ej. "1122334455", instrucción pensada para los links
// manuales de wa.me, que WhatsApp corrige solo al abrirlos) — pero Baileys
// no perdona: si el JID no tiene el 54 (Argentina) + 9 (celular argentino)
// exactos, no encuentra la cuenta y el envío falla en silencio, cayendo al
// modo manual. Acá se arma ese formato a partir de lo que haya cargado el
// usuario, sea cual sea la forma en que lo haya escrito.
function numeroAJid(numero) {
  let digitos = (numero || '').replace(/\D/g, '');
  if (!digitos) return null;

  // Si ya viene con 54 al principio, se lo sacamos para analizar el resto
  // como número local y volver a armarlo siempre de la misma manera —
  // evita duplicar el 54 o dejarlo mal puesto según cómo lo haya tipeado
  // cada uno (con o sin 54, con o sin 0/9/15 de más).
  if (digitos.startsWith('54')) digitos = digitos.slice(2);
  // El "0" de discado nacional (ej. la gente que carga "011 ..." en vez de
  // "11 ...") tampoco va en el JID — solo va el código de área pelado.
  if (digitos.startsWith('0')) digitos = digitos.slice(1);
  // El "9" que WhatsApp exige para celulares argentinos a veces ya está
  // cargado (por gente que lo sabe) y a veces no — se saca si está, para
  // volver a agregarlo siempre en el mismo lugar.
  if (digitos.startsWith('9')) digitos = digitos.slice(1);

  // El viejo "15" de celular argentino (ej. "011 15 2233-4455") NO va
  // pegado al principio del número entero — va DESPUÉS del código de área,
  // y el código de área puede tener 2, 3 o 4 dígitos según la ciudad ("11"
  // Buenos Aires, "351" Córdoba, etc.). El chequeo anterior acá
  // (digitos.startsWith('15')) solo detectaba el caso en que no hubiera
  // código de área en absoluto — para el caso real y mucho más común de
  // "ÁREA + 15 + número" (ej. "1115-2233-4455") no hacía nada, el "15"
  // quedaba pegado en el medio del número y el JID resultante tenía 2
  // dígitos de más: no correspondía a ninguna cuenta real de WhatsApp, así
  // que Baileys no tiraba error (el envío "funcionaba" del lado del
  // código) pero el mensaje no le llegaba a nadie. Un número argentino de
  // área+local sin el 15 mide siempre 10 dígitos — si mide 12, lo más
  // probable es que tenga un "15" de más metido después del código de
  // área; se prueban las 3 posiciones posibles (largo de área 2, 3 o 4) y
  // se saca de ahí donde aparezca.
  if (digitos.length === 12) {
    for (const largoArea of [2, 3, 4]) {
      if (digitos.slice(largoArea, largoArea + 2) === '15') {
        digitos = digitos.slice(0, largoArea) + digitos.slice(largoArea + 2);
        break;
      }
    }
  }

  return `549${digitos}@s.whatsapp.net`;
}

async function iniciarWhatsappPersonal() {
  if (reintentoTimer) { clearTimeout(reintentoTimer); reintentoTimer = null; }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    auth: state,
    logger,
    // No usamos printQRInTerminal (deprecado y además inútil acá: este
    // server corre en la PC de Maxi sin que nadie esté mirando su
    // terminal) — el QR se toma del propio evento connection.update y se
    // renderiza a imagen con el paquete qrcode, ver más abajo.
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        qrDataUrl = await QRCode.toDataURL(qr);
        estado = 'esperando_qr';
      } catch (e) {
        console.error('Error generando imagen del QR de WhatsApp:', e.message);
      }
    }

    if (connection === 'open') {
      estado = 'conectado';
      qrDataUrl = null;
      // sock.user.id viene como "54911XXXXXXXX:12@s.whatsapp.net" (el
      // ":12" es el ID del dispositivo dentro de esa cuenta) — se muestra
      // solo la parte numérica en la UI.
      numeroConectado = (sock.user?.id || '').split(':')[0].split('@')[0] || null;
      console.log(`WhatsApp (número personal) conectado${numeroConectado ? ': +' + numeroConectado : ''}.`);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : lastDisconnect?.error?.output?.statusCode;
      const deslogueado = statusCode === DisconnectReason.loggedOut;

      estado = 'desconectado';
      qrDataUrl = null;
      numeroConectado = null;
      sock = null;

      if (deslogueado) {
        // Cerraron sesión desde el teléfono (o se llamó a
        // desvincularWhatsapp()) — no tiene sentido reintentar solo, hay
        // que escanear un QR nuevo. Se limpian las credenciales viejas
        // para que el próximo arranque pida QR de una en vez de fallar
        // en loop contra una sesión que WhatsApp ya invalidó.
        limpiarSesionEnDisco();
        console.log('WhatsApp (número personal) desvinculado — hace falta escanear un QR nuevo.');
        return;
      }

      // Cualquier otro motivo de corte (se cayó la red, WhatsApp reinició
      // la conexión, etc.) — se reintenta solo, siguiendo el mismo patrón
      // documentado por Baileys (ver README, "Example to Start"). Se usa
      // un pequeño delay en vez de reconectar en el instante para no
      // entrar en un loop apretado si el corte es persistente.
      console.error('Se cortó la conexión de WhatsApp (número personal), reintentando en 10s:', lastDisconnect?.error?.message || lastDisconnect?.error);
      reintentoTimer = setTimeout(() => {
        iniciarWhatsappPersonal().catch(e => console.error('Error reconectando WhatsApp:', e.message));
      }, 10000);
    }
  });
}

function limpiarSesionEnDisco() {
  try {
    fs.readdirSync(SESSION_DIR).forEach(f => fs.rmSync(path.join(SESSION_DIR, f), { force: true }));
  } catch (e) {
    console.error('Error limpiando sesión de WhatsApp en disco:', e.message);
  }
}

// Para que lo use un admin desde Configuración: cierra la sesión actual
// (si había alguna) y borra las credenciales guardadas, para poder
// vincular un número distinto desde cero. No debe tirar error si ya
// estaba desconectado (ej. todavía no se escaneó ningún QR nunca en esta
// instalación) — es un caso normal, no una falla.
async function desvincularWhatsapp() {
  if (reintentoTimer) { clearTimeout(reintentoTimer); reintentoTimer = null; }
  try {
    if (sock) await sock.logout();
  } catch (e) {
    // sock.logout() ya dispara connection.update con loggedOut y limpia el
    // estado/la sesión en disco solo (ver arriba) — si además tira una
    // excepción acá (ej. porque el socket ya estaba caído), no es un error
    // real de cara al admin, solo se loguea.
    console.error('Aviso al desvincular WhatsApp (no bloqueante):', e.message);
  }
  sock = null;
  estado = 'desconectado';
  qrDataUrl = null;
  numeroConectado = null;
  limpiarSesionEnDisco();
  // Se re-arranca de una para que Configuración pueda mostrar un QR nuevo
  // sin que haga falta reiniciar el server entero.
  await iniciarWhatsappPersonal().catch(e => console.error('Error re-arrancando WhatsApp tras desvincular:', e.message));
}

// Usado por whatsapp.js. Tira una excepción si no se pudo mandar (sea
// porque no hay conexión, sea porque Baileys rechazó el envío) — es
// responsabilidad de quien llama (enviarWhatsApp) decidir qué hacer con
// eso (acá: dejar la fila en whatsapp_outbox como pendiente de mano).
async function enviarPorWhatsappPersonal(numero, mensaje) {
  if (estado !== 'conectado' || !sock) {
    throw new Error('WhatsApp (número personal) no está conectado.');
  }
  const jid = numeroAJid(numero);
  if (!jid) throw new Error('Número de celular inválido o vacío.');
  await sock.sendMessage(jid, { text: mensaje });
}

module.exports = {
  iniciarWhatsappPersonal,
  desvincularWhatsapp,
  enviarPorWhatsappPersonal,
  getEstadoWhatsapp,
};
