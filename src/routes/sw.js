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
