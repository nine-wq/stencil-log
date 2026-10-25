// Service worker: installable app, offline start of the app shell, and files shared from other apps
// (manifest share_target -> POST /share-target -> files kept in cache 'film-share' -> /?share=… opens the artwork library).
const SHELL = 'stencil-shell-v1';
const ASSETS = ['/', '/app.js', '/style.css', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png',
  '/film/', '/film/js/film-core.js', '/film/vendor/pdf-lib.min.js', '/film/vendor/jszip.min.js', '/film/vendor/pdf.min.js', '/film/vendor/pdf.worker.min.js'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).catch(() => {}));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('stencil-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.method === 'POST' && url.pathname === '/share-target') { e.respondWith(takeShare(req)); return; }
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;   // data always from the server
  const key = req.mode === 'navigate' ? (url.pathname.startsWith('/film') ? '/film/' : '/') : req;
  // network first (always the newest app), the stored copy only when offline
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') { const c = await caches.open(SHELL); c.put(key, res.clone()); }
      return res;
    } catch (err) {
      const hit = await caches.match(key, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
async function takeShare(req) {
  let n = 0;
  try {
    const form = await req.formData();
    const cache = await caches.open('film-share');
    for (const k of await cache.keys()) await cache.delete(k);
    for (const f of form.getAll('file')) {
      if (!f || typeof f === 'string' || !f.size) continue;
      await cache.put(`/__shared/${Date.now()}-${n++}`, new Response(f, { headers: { 'x-name': encodeURIComponent(f.name || 'shared'), 'content-type': f.type || 'application/octet-stream' } }));
    }
  } catch (e) {}
  return Response.redirect(`/?share=${n ? Date.now() : 'none'}`, 303);
}
