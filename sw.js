const CACHE = 'biztinder-v1';
const ASSETS = ['/', '/index.html', '/styles.css', '/script.js', '/manifest.webmanifest', '/src/matchEngine.js', '/src/discovery.js'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});
self.addEventListener('fetch', (e) => {
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
