const CACHE_NAME = 'vine-scanner-v20-2026-08-12';
const CORE = ['./', './index.html'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.allSettled(CORE.map(url => cache.add(url)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isDataRequest(url) {
  const p = url.pathname.toLowerCase();
  return p.endsWith('.xlsx') || p.endsWith('v20_data_version.json');
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isDataRequest(url)) {
    // Données : réseau d'abord pour avoir la dernière version, cache en secours hors ligne.
    event.respondWith(
      fetch(req).then(resp => {
        if (resp && resp.ok) caches.open(CACHE_NAME).then(cache => cache.put(req, resp.clone()));
        return resp;
      }).catch(() => caches.match(req).then(r => r || caches.match(url.pathname)))
    );
    return;
  }

  // Page et bibliothèques : cache d'abord, puis réseau et mise en cache dynamique.
  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      if (resp && resp.ok) caches.open(CACHE_NAME).then(cache => cache.put(req, resp.clone()));
      return resp;
    }))
  );
});
