/* AÖF Sınav Robotu — service worker
   Uygulama kabuğu: önce ağ (güncel sürüm), çevrimdışıysa önbellek.
   Soru görselleri: önce önbellek (çevrimdışı çalışma). Proxy istekleri önbelleğe alınmaz. */
const SHELL = 'aof-shell-v23.0';
const IMG = 'aof-img-v1';
const ASSETS = ['./', './index.html', './assets/app.css?v=23.0', './assets/app.js?v=23.0', './manifest.webmanifest',
  './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png', './assets/apple-touch-icon.png'];
const IMG_HOSTS = ['image.aofsoru.com', 'image.ataaofsoru.com'];
const IMG_MAX = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('aof-shell-') && k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
async function trimImages() {
  const c = await caches.open(IMG);
  const keys = await c.keys();
  if (keys.length > IMG_MAX) await Promise.all(keys.slice(0, keys.length - IMG_MAX).map((k) => c.delete(k)));
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (IMG_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(IMG);
      const hit = await c.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req.url, { mode: 'no-cors', credentials: 'omit' });
        if (res && (res.ok || res.type === 'opaque')) { c.put(req.url, res.clone()).then(() => Math.random() < 0.05 && trimImages()).catch(() => {}); }
        return res;
      } catch (err) {
        return hit || Response.error();
      }
    })());
    return;
  }
  if (url.origin !== self.location.origin) return; // proxy / dış istekler: dokunma
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') c.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await c.match('./index.html')) || (await c.match('./'));
      return Response.error();
    }
  })());
});
