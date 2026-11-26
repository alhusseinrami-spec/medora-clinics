/* MEDORA service worker: offline app shell + push notifications.
   API responses (/api/*) are never cached: they hold patient data and must always come from the server. */
const VERSION = 'medora-v2';
// Registered with ?dev=1 under next dev, where chunk names are not content-hashed: then nothing is cached.
const DEV = new URL(self.location.href).searchParams.has('dev');
const SHELL = ['/offline.html', '/icon.svg', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api')) return;
  // Hashed build assets never change: cache first.
  if (!DEV && (url.pathname.startsWith('/_next/static/') || /\.(png|svg|woff2?)$/.test(url.pathname))) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res;
    }));
    return;
  }
  // Pages: always the network; offline, a plain notice (pages are not stored because they can show personal data).
  if (req.mode === 'navigate') e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
});

// The server sends only a generic title and body (never medical details) plus a link.
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'MEDORA', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || undefined, data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url === target && 'focus' in c) return c.focus();
    return self.clients.openWindow(target);
  }));
});
