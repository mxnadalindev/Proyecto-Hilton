require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Se necesita antes de configurar la sesión (más abajo), para poder
// guardar las sesiones en esta misma base en vez de en la memoria del
// proceso — ver el comentario junto a app.use(session(...)). Esto además
// arranca la conexión a Postgres y la creación/actualización de tablas,
// que antes se disparaba más abajo en este archivo; movido solo más
// arriba, no cambia qué hace.
const db = require('./src/db/database');

['uploads'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
const PORT = process.env.PORT || 5000;

// ── Red de seguridad global ─────────────────────────────────────────
// Varias rutas del portal hacen "await db.all2(...)" sin try/catch. Si esa
// consulta falla (una tabla que todavía no existe en esta instancia, un
// corte momentáneo de conexión con Postgres, etc.), la promesa rechazada
// queda "sin capturar" — y desde Node 15 eso tira abajo TODO el proceso,
// no solo esa página (así se cayó el server al entrar a Configuración).
// Con este handler, ese mismo error se loguea en la consola pero el
// servidor sigue de pie para todos los demás usuarios conectados.
process.on('unhandledRejection', (reason) => {
  console.error('⚠ Promesa rechazada sin capturar (el servidor sigue corriendo):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠ Excepción sin capturar (el servidor sigue corriendo):', err);
});

// El límite de 2GB (pensado para el upload de video de Recetas) estaba
// puesto acá de forma GLOBAL — se aplicaba a TODAS las rutas del sistema,
// no solo a la que realmente necesita subir algo pesado. Los uploads de
// archivos (fotos, CSV, remitos, video) van por otro mecanismo (multer,
// ver cada router) y no dependen de este límite en absoluto — este es
// solo para formularios normales y pedidos JSON, que nunca necesitan
// acercarse a ese tamaño. 5mb es de sobra hasta para el formulario más
// grande del sitio (con muchos campos/checkboxes) y evita que cualquier
// pedido a cualquier ruta pueda obligar al servidor a cargar en memoria
// un cuerpo enorme.
// Comprime (gzip) todo lo que el servidor manda al navegador — HTML, CSS,
// JS, respuestas de las rutas de API. Antes no había nada de esto: cada
// página se mandaba entera, sin comprimir. Se nota más en el celular con
// la red del hotel. No afecta los uploads (van directo a disco por otro
// camino) ni los archivos ya comprimidos (imágenes, video) — compression
// los detecta y no pierde tiempo intentando comprimirlos de nuevo.
app.use(compression());

app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '60s', // ayuda a que no se re-pida todo en cada página, sin arriesgar quedarse con CSS viejo por mucho tiempo mientras seguimos cambiando cosas
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Las páginas del portal (Personal, Horarios, etc.) nunca se guardan en caché del navegador —
// siempre se piden frescas al servidor, así los cambios (como el RECOFF) se ven de una,
// sin que el usuario tenga que recargar fuerte a mano.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// Complemento del handler de unhandledRejection de arriba: si una ruta se
// cuelga porque su promesa rechazada quedó "atrapada" sin responder nunca
// (en vez de tirar el servidor abajo, como pasaba antes), este timeout hace
// que el usuario vea una página de error a los 20s en vez de un spinner
// infinito en el navegador.
//
// OJO — /asistente/mensaje queda afuera de este watchdog genérico por dos
// motivos, encontrados al revisar un error real que reportó Maxi
// ("No pude conectarme. Probá de nuevo." en el chat):
//   1) Es una ruta de API que siempre responde JSON — pero este watchdog
//      manda una PÁGINA HTML (res.render('error', ...)). Si el timeout de
//      20s se disparaba antes de que Gemini contestara (cosa esperable:
//      llamarGeminiConReintentos ya tiene sus propios reintentos con
//      backoff, que solos pueden tardar más de 20s), el navegador recibía
//      HTML donde esperaba JSON, resp.json() tiraba una excepción del lado
//      del navegador, y el chat mostraba el mensaje genérico de "no pude
//      conectarme" — aunque el pedido en realidad seguía en curso.
//   2) Peor: cuando esa respuesta HTML de "timeout" ya se había mandado,
//      y el asistente terminaba de procesar unos segundos después, volvía
//      a intentar mandar SU propia respuesta sobre la misma conexión ya
//      cerrada — eso tiraba "Cannot set headers after they are sent"
//      (se ve en el log, pero no tira el servidor abajo gracias al
//      handler de unhandledRejection de más arriba).
// Como el asistente ya tiene sus propios tiempos de espera (45s por
// intento a Gemini, hasta 3 intentos), le damos acá su propio watchdog más
// largo (55s) que además responde JSON en vez de HTML.
app.use((req, res, next) => {
  const esAsistente = req.originalUrl.startsWith('/asistente/mensaje');
  // OJO: esto es un timer de JS común, NO req.setTimeout()/socket.setTimeout()
  // — probamos esa opción primero y en este Node (v22) el socket se cierra
  // solo al vencer el timeout, sin darle nunca la oportunidad al callback
  // de mandar una respuesta (el navegador termina viendo una conexión
  // cortada en vez de la página de error). Con un timer normal sí funciona.
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      console.error(`⚠ Timeout de ${esAsistente ? '55' : '20'}s en ${req.method} ${req.originalUrl}`);
      if (esAsistente) {
        res.status(504).json({ ok: false, error: 'El asistente tardó demasiado en responder. Probá de nuevo en un momento.' });
      } else {
        res.status(504).render('error', {
          mensaje: 'La página tardó demasiado en responder. Probá de nuevo — si vuelve a pasar, avisale al admin.',
          volver: '/inicio',
        });
      }
    }
  }, esAsistente ? 55000 : 20000);
  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  next();
});

if (!process.env.SESSION_SECRET) {
  console.warn('⚠ SESSION_SECRET no está seteada en el .env — usando el valor por default (menos seguro). Para sacar este aviso, agregá SESSION_SECRET=... al .env con cualquier texto largo y aleatorio.');
}

app.use(session({
  // Antes las sesiones se guardaban solo en la memoria (RAM) del proceso
  // de Node (comportamiento por default de express-session si no se le
  // indica un "store") — la propia documentación de express-session dice
  // que eso no es apto para producción. En la práctica esto se notaba
  // cada vez que reiniciábamos el servidor para instalar un arreglo: se
  // desloguea a TODO el mundo, sin aviso, porque esa memoria se pierde al
  // reiniciar. Ahora se guardan en la misma base PostgreSQL que ya usa el
  // sistema (misma conexión — "pool" — que ya usan el resto de las
  // consultas, no se abre una conexión aparte), así sobreviven a un
  // reinicio del servidor. createTableIfMissing crea sola la tabla
  // "session" la primera vez, mismo patrón que ya usa el resto del
  // sistema para sus propias tablas (ver src/db/database.js).
  store: new pgSession({ pool: db.pool, createTableIfMissing: true }),
  // Igual que la contraseña de la base: se puede fijar SESSION_SECRET en el
  // .env para no tener un secreto hardcodeado en el código fuente público
  // del repo — si no está seteada, sigue usando la misma de siempre (no se
  // fuerza un cambio de comportamiento acá tampoco — ver el aviso de
  // consola más arriba, que sí avisa fuerte cuando falta).
  secret: process.env.SESSION_SECRET || 'hilton_ba_futurelab_2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax'
    // Sin maxAge = cookie de sesión, se destruye al cerrar el navegador
  }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  next();
});
app.use('/configuracion', require('./src/routes/configuracion'));
app.use('/',         require('./src/routes/auth'));
app.use('/eventos',  require('./src/routes/eventos'));
// "/miembros-de-equipo" es la URL nueva y la que se linkea desde el menú;
// "/personal" se deja funcionando en paralelo (mismo router) por si quedó
// algún acceso directo o favorito guardado con la URL vieja — las rutas
// internas del propio router (formularios, redirects) siguen usando
// "/personal" adentro, así que no hace falta tocar nada más para que sigan
// andando igual sin importar por cuál de las dos entraste.
app.use('/miembros-de-equipo', require('./src/routes/personal'));
app.use('/personal', require('./src/routes/personal'));
app.use('/recetas',  require('./src/routes/recetas'));
app.use('/horarios', require('./src/routes/horarios'));
app.use('/costos',   require('./src/routes/costos'));
app.use('/horas-extra', require('./src/routes/horasExtra'));  // ← NUEVO — Cocina: carga y reporte de horas extra (solo admin)
app.use('/compras',  require('./src/routes/compras'));   // ← NUEVO
app.use('/croutons', require('./src/routes/croutons'));  // ← NUEVO — AYB: carga de mercadería y vencimientos
app.use('/inventario-ayb', require('./src/routes/inventarioAyb'));  // ← NUEVO — AYB: stock de barra, separado de Croutons
app.use('/desayuno', require('./src/routes/desayuno'));  // ← NUEVO — AYB: reporte de desayuno por habitación (hostess)
app.use('/asistente', require('./src/routes/asistente'));

// Escalamiento automático de convocatorias de AYB (fijos → eventuales →
// consultoras) — ver src/services/escalamientoAyb.js. Arranca una sola vez
// acá, no en el router de horarios, para que no dependa de que alguien
// entre a esa pantalla: tiene que revisar los eventos igual aunque nadie
// esté mirando el portal en ese momento.
require('./src/services/escalamientoAyb').iniciarEscalamientoAyb(5);

// Puente de WhatsApp por número PERSONAL (Baileys, NO la API oficial de
// Meta — ver el comentario grande en src/services/whatsappPersonal.js).
// Se arranca acá, antes de que corra el primer tick de escalamiento, para
// que si ya había una sesión guardada en data/whatsapp_session/ (de un
// arranque anterior) quede reconectada y lista para mandar mensajes reales
// desde el primer tick, no solo desde el segundo. Un fallo acá (ej. la
// carpeta de sesión corrupta) no debe impedir que el resto del portal
// arranque — igual queda el fallback de whatsapp_outbox.
require('./src/services/whatsappPersonal').iniciarWhatsappPersonal()
  .catch(e => console.error('Error arrancando el puente de WhatsApp (número personal):', e.message));

// 404 — ruta que no matcheó ninguna de las de arriba
app.use((req, res) => {
  res.status(404).render('error', {
    mensaje: 'Esa página no existe.',
    volver: '/inicio',
  });
});

// Manejador de errores de Express (4 argumentos) — última red de
// contención: si alguna ruta llama a next(err) explícitamente, cae acá
// en vez de mostrar el stack trace crudo de Express al usuario.
app.use((err, req, res, next) => {
  console.error('⚠ Error en', req.method, req.originalUrl, ':', err.message);
  if (res.headersSent) return next(err);
  res.status(500).render('error', {
    mensaje: 'Ocurrió un error inesperado. Probá de nuevo — si vuelve a pasar, avisale al admin.',
    volver: '/inicio',
  });
});

// Mostrar IPs de acceso — misma lógica que usa src/utils/red.js para
// armar los links de invitación de WhatsApp (que necesitan la IP de red
// local, no "localhost", para poder abrirse desde el celular del mozo).
// Se reusa de ahí en vez de reimplementarla acá para que las dos cosas no
// se puedan desincronizar con el tiempo.
const { getIpsLocales } = require('./src/utils/red');

app.listen(PORT, '0.0.0.0', () => {
  const ips = getIpsLocales();
  console.log('\n✓ Hilton Portal corriendo\n');
  console.log(`  Esta PC:    http://localhost:${PORT}`);
  ips.forEach(ip => {
    console.log(`  Red local:  http://${ip}:${PORT}  ← usar en celulares`);
  });
  console.log('\n  Compartí el link de "Red local" con los celulares\n');

  // Abre el navegador automáticamente en esta PC (no en los celulares, obvio)
  const urlLocal = `http://localhost:${PORT}`;
  const comandoPorSO = {
    win32: `start "" "${urlLocal}"`,
    darwin: `open "${urlLocal}"`,
    linux: `xdg-open "${urlLocal}"`,
  }[process.platform];

  if (comandoPorSO) {
    require('child_process').exec(comandoPorSO, (err) => {
      if (err) console.log('  (No se pudo abrir el navegador solo — abrilo a mano en la URL de arriba)');
    });
  }
});
