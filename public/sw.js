// sw.js — Service Worker básico para PWA
const CACHE = 'hilton-v1';
const ASSETS = ['/css/style.css', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('fetch', e => {
  // Solo cachear assets estáticos, no las requests del servidor
  if (e.request.url.includes('/css/') || e.request.url.includes('/img/')) {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request))
    );
  }
});
