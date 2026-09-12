const CACHE_NAME = 'circuitnet-v51';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './logo-login.png',
  './logo-drawer.png',
  './logo-header.png',
  './lib/html5-qrcode.min.js',
  './lib/xlsx.full.min.js',
  './version.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS).catch(()=>{})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim()).then(() => {
      // Notify ALL clients that a new version is active
      return self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'FORCE_UPDATE', version: CACHE_NAME }));
      });
    })
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Don't intercept Supabase API calls — they must always hit the network
  if (e.request.url.includes('supabase.co')) return;
  if (e.request.url.includes('ocr.space')) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, copy)).catch(()=>{});
        return resp;
      }).catch(() => cached || new Response('Offline', {status: 503}));
    })
  );
});
