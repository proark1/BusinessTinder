const CACHE = 'biztinder-v12';
const ASSETS = ['/', '/index.html', '/styles.css', '/script.js', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
// Only static assets are eligible for the cache. Everything else (all API
// routes, including new ones we haven't enumerated, and the public profile
// pages) goes straight to the network — an allowlist is safer than a bypass
// list, which silently caches any endpoint someone forgets to add.
const STATIC_EXT = /\.(css|js|svg|png|ico|webmanifest|woff2?|jpg|jpeg|gif|webp)$/i;
function isCacheable(url) {
  return (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/manifest.webmanifest' ||
    STATIC_EXT.test(url.pathname)
  );
}
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !isCacheable(url)) return; // network-only
  // Network-first for the HTML shell and core JS/CSS so deploys roll out
  // immediately; cache is the offline fallback.
  if (
    e.request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/script.js' ||
    url.pathname === '/styles.css'
  ) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // Cache-first for the other static assets, refreshing the cache in the
  // background, and falling back to the network on a miss.
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
self.addEventListener('push', (e) => {
  const data = (() => { try { return e.data?.json(); } catch { return { title: 'BusinessTinder', body: 'New activity' }; } })();
  e.waitUntil(self.registration.showNotification(data.title || 'BusinessTinder', { body: data.body || '', icon: '/icon.svg', badge: '/icon.svg' }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow('/'));
});
