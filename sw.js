// Offline shell. The API is never cached here: the page handles it, with its own retries and queue.
const V = 'aarve-v4';
const SHELL = ['./', 'index.html', 'styles.css?v=3', 'app.js?v=3', 'config.js', 'fonts/fonts.css', 'fonts/cormorant.woff2', 'fonts/cormorant-italic.woff2', 'fonts/hanken.woff2', 'assets/favicon.svg', 'manifest.webmanifest', 'assets/img/hero.webp', 'assets/img/hero.jpg', 'assets/img/pull-story-v2.jpg', 'assets/img/construction-v2.jpg', 'assets/img/macro.jpg', 'assets/img/front.jpg', 'assets/img/rear.jpg', 'assets/img/side.jpg', 'assets/img/thumb.jpg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/admin/')) return;
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then((res) => { const cp = res.clone(); caches.open(V).then((c) => c.put('index.html', cp)); return res; }).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.open(V).then(async (c) => {
    const hit = await c.match(r);
    const net = fetch(r).then((res) => { if (res.ok) c.put(r, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
