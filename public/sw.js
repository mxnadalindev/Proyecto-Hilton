// sw.js — Service Worker básico para PWA
// v2: estrategia "red primero" — siempre intenta traer la versión más nueva del
// servidor; solo usa la caché como respaldo si no hay conexión. Así un cambio en
// style.css (u otro asset) se refleja al toque, en vez de quedar pegado para siempre
// en lo que se haya cacheado la primera vez.
const CACHE = 'hilton-v2';
const ASSETS = ['/css/style.css', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// Al activarse, borra cachés de versiones viejas (hilton-v1, etc.)
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(nombres =>
      Promise.all(nombres.filter(n => n !== CACHE).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/css/') || e.request.url.includes('/img/')) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          // Actualiza la caché con la versión fresca para la próxima vez que no haya red
          const copia = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copia));
          return resp;
        })
        .catch(() => caches.match(e.request)) // sin conexión: usa lo último que haya en caché
    );
  }
});

// ── Notificaciones push (avisos de vencimiento y demás) ──
// Llega un mensaje del servidor aunque el navegador esté cerrado o en
// background — el sistema operativo despierta el service worker solo para
// mostrar la notificación.
self.addEventListener('push', event => {
  let datos = {};
  try { datos = event.data ? event.data.json() : {}; } catch (e) { datos = {}; }

  const titulo = datos.title || 'Aviso — Hilton';
  const opciones = {
    body: datos.body || '',
    icon: '/img/BUEHI_K_RGB (1).png',
    badge: '/img/BUEHI_K_RGB (1).png',
    data: { url: datos.url || '/inicio' },
  };

  event.waitUntil(self.registration.showNotification(titulo, opciones));
});

// Al tocar la notificación, lleva a la pantalla correspondiente (o la enfoca
// si ya está abierta en otra pestaña, en vez de abrir una nueva de más)
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/inicio';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(listaClientes => {
      for (const cliente of listaClientes) {
        if (cliente.url.includes(url) && 'focus' in cliente) return cliente.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
