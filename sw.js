const CACHE = 'biztinder-v2';
const ASSETS = ['/', '/index.html', '/styles.css', '/script.js', '/manifest.webmanifest', '/src/matchEngine.js', '/src/discovery.js', '/src/swipeState.js', '/src/portability.js'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache API or auth or WS calls
  if (
    url.pathname.startsWith('/auth') ||
    url.pathname.startsWith('/discover') ||
    url.pathname.startsWith('/me') ||
    url.pathname.startsWith('/matches') ||
    url.pathname.startsWith('/messages') ||
    url.pathname.startsWith('/swipes') ||
    url.pathname.startsWith('/likes') ||
    url.pathname.startsWith('/saved') ||
    url.pathname.startsWith('/blocks') ||
    url.pathname.startsWith('/reports') ||
    url.pathname.startsWith('/push') ||
    url.pathname.startsWith('/plan') ||
    url.pathname.startsWith('/referrals') ||
    url.pathname.startsWith('/icebreakers') ||
    url.pathname.startsWith('/search') ||
    url.pathname.startsWith('/health') ||
    url.pathname.startsWith('/u/') ||
    url.pathname === '/profiles' ||
    url.pathname.startsWith('/profiles/')
  ) {
    return; // let it pass through
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
self.addEventListener('push', (e) => {
  const data = (() => { try { return e.data?.json(); } catch { return { title: 'BusinessTinder', body: 'New activity' }; } })();
  e.waitUntil(self.registration.showNotification(data.title || 'BusinessTinder', { body: data.body || '', icon: '/icon.png' }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow('/'));
});
