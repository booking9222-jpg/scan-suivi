/* Scanner Suivi M110 — Service Worker V40.3.23 */
const CACHE_NAME = 'vine-m110-v40.3.23';
const PAGE_PATH = './Scanner-Suivi-M110-v12.html';
const STATIC_ASSETS = [
  PAGE_PATH,
  './Dernier Fonctionnel_files/xlsx.full.min.js.télécharger',
  './Dernier Fonctionnel_files/html5-qrcode.min.js.télécharger',
  './Dernier Fonctionnel_files/JsBarcode.all.min.js.télécharger',
  './Dernier Fonctionnel_files/jspdf.umd.min.js.télécharger'
];
const STATIC_PATHS = new Set(STATIC_ASSETS.map(x => new URL(x, self.location.href).pathname));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(STATIC_ASSETS.map(async url => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res && res.ok) await cache.put(url, res.clone());
      } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('vine-m110-') && n !== CACHE_NAME).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

function isExternalOrApi(url) {
  if (url.origin !== self.location.origin) return true;
  return false;
}

async function networkFirstPage(request) {
  const cache = await caches.open(CACHE_NAME);
  const url = new URL(request.url);
  const canonical = new Request(url.origin + url.pathname, { credentials: 'same-origin' });
  try {
    const response = await fetch(request);
    if (response && response.ok) await cache.put(canonical, response.clone());
    return response;
  } catch (err) {
    return (await cache.match(canonical)) || (await cache.match(PAGE_PATH)) || Promise.reject(err);
  }
}

async function cacheFirstStatic(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) {
    fetch(request).then(r => { if (r && r.ok) cache.put(request, r.clone()); }).catch(() => {});
    return cached;
  }
  const response = await fetch(request);
  if (response && response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (!request || request.method !== 'GET') return;
  const url = new URL(request.url);

  // Les appels Apps Script / GitHub / CDN / autres origines ne sont JAMAIS
  // servis par ce cache : on garde les données VINE et les APIs en réseau pur.
  if (isExternalOrApi(url)) {
    event.respondWith(fetch(request));
    return;
  }

  // Le service worker lui-même doit toujours venir du réseau.
  if (/\/sw\.js$/i.test(url.pathname)) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  const isHtml = request.mode === 'navigate' || /\.html$/i.test(url.pathname);
  if (isHtml) {
    event.respondWith(networkFirstPage(request));
    return;
  }

  // Finalisation V40.3.23 : seuls les fichiers statiques explicitement connus
  // peuvent être servis depuis le cache. Toute autre ressource same-origin reste
  // réseau pur afin qu'un futur JSON/API ajouté au dépôt ne puisse jamais être figé.
  if (STATIC_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirstStatic(request));
    return;
  }
  event.respondWith(fetch(request));
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
