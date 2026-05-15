const CACHE = 'biztinder-v3';
const ASSETS = ['/', '/index.html', '/styles.css', '/script.js', '/manifest.webmanifest', '/icon.svg', '/src/matchEngine.js', '/src/discovery.js', '/src/swipeState.js', '/src/portability.js'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const bypass = [
    '/auth', '/discover', '/me', '/matches', '/messages', '/conversations',
    '/swipes', '/likes', '/saved', '/blocks', '/reports', '/push', '/plan',
    '/referrals', '/icebreakers', '/search', '/health', '/u/', '/profiles',
  ];
  if (bypass.some((p) => url.pathname === p || url.pathname.startsWith(p + '/') || (p === '/profiles' && url.pathname === '/profiles'))) return;
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
