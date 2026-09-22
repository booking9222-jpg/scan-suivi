const CACHE_NAME = 'vine-scanner-v42.0.3-quarantaine-2026-09-21';
const CORE = ['./'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(CORE.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isDataRequest(url) {
  const p = url.pathname.toLowerCase();
  return p.endsWith('.xlsx') || p.endsWith('.csv') || p.endsWith('v20_data_version.json');
}

function isFreshCodeRequest(req, url) {
  const p = url.pathname.toLowerCase();
  return req.mode === 'navigate' || p.endsWith('.html') || p.endsWith('.js') || p.endsWith('.css');
}

async function networkFirst(req) {
  try {
    const resp = await fetch(req, { cache: 'no-store' });
    if (resp && resp.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (_) {
    return (await caches.match(req)) || (await caches.match('./')) || Response.error();
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isDataRequest(url) || isFreshCodeRequest(req, url)) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Bibliothèques/images statiques : cache d'abord, réseau en secours.
  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      if (resp && resp.ok) caches.open(CACHE_NAME).then(cache => cache.put(req, resp.clone()));
      return resp;
    }))
  );
});
