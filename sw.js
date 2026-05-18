const CACHE = 'biztinder-v9';
const ASSETS = ['/', '/index.html', '/styles.css', '/script.js', '/manifest.webmanifest', '/icon.svg', '/src/matchEngine.js', '/src/discovery.js', '/src/swipeState.js', '/src/portability.js'];
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
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const bypass = [
    '/auth', '/discover', '/me', '/matches', '/messages', '/conversations',
    '/swipes', '/likes', '/saved', '/blocks', '/reports', '/push', '/plan',
    '/referrals', '/icebreakers', '/search', '/health', '/u/', '/profiles',
    '/prompts', '/profile-views', '/upload', '/admin', '/boost',
  ];
  if (bypass.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))) return;
  // Always go to network for the HTML shell AND for the core JS/CSS so
  // deploys roll out immediately. Cache stays as the offline fallback.
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
