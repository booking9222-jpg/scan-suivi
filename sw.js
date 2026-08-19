/* Scanner Suivi → ASIN → M110 — Service Worker V24 */
const VERSION = '24.0.0';
const CACHE_NAME = `vine-m110-${VERSION}`;
const APP_SHELL = [
  './',
  './index.html',
  './Dernier Fonctionnel_files/xlsx.full.min.js.télécharger',
  './Dernier Fonctionnel_files/html5-qrcode.min.js.télécharger',
  './Dernier Fonctionnel_files/JsBarcode.all.min.js.télécharger',
  './Dernier Fonctionnel_files/jspdf.umd.min.js.télécharger'
];

async function cacheShellBestEffort() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.allSettled(APP_SHELL.map(async (url) => {
    try {
      const req = new Request(url, { cache: 'reload' });
      const res = await fetch(req);
      if (res && res.ok) await cache.put(url, res.clone());
    } catch (_) {}
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await cacheShellBestEffort();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Supprime uniquement les anciennes versions créées par ce SW V24+.
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('vine-m110-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Très important : ne jamais intercepter/cache les appels Apps Script/Google.
  // Le SW ne gère que les fichiers du site GitHub lui-même.
  if (url.origin !== self.location.origin) return;

  const isNavigation = req.mode === 'navigate' ||
    url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');

  if (isNavigation) {
    // NETWORK FIRST : récupère la nouvelle version dès qu'Internet est disponible.
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('./index.html', fresh.clone());
        }
        return fresh;
      } catch (_) {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Bibliothèques/fichiers statiques : cache d'abord, réseau si absent.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) await cache.put(req, fresh.clone());
      return fresh;
    } catch (_) {
      return Response.error();
    }
  })());
});
