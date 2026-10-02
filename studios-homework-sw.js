const CACHE = 'studios-homework-pwa-v1';
const CORE = [
  './',
  './index.html',
  './studios-homework-v88.webmanifest',
  './account-layer.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE).catch(() => {})));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'CACHE_URL' && event.data.url) {
    event.waitUntil(caches.open(CACHE).then(c => c.add(event.data.url).catch(() => {})));
  }
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then(cached => cached || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
