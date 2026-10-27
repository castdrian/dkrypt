const CACHE_NAME = 'dkrypt-shell-__DKRYPT_BUILD__';
const APP_SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/favicon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Never cache the API - job status, keys, and everything else under /v1/ is live/authenticated
// data that must never be served stale. Static assets (the app shell, hashed JS/CSS bundles) go
// network-first with a cache fallback, so the app still loads something useful while offline or
// on a flaky connection, but always prefers a fresh copy when the network is actually up.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/v1/')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match('/'))),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') event.waitUntil(self.skipWaiting());
});

self.addEventListener('push', (event) => {
  let payload = { title: 'dkrypt', body: '', url: '/', actions: [] };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    payload = { title: 'dkrypt', body: event.data ? event.data.text() : '', url: '/', actions: [] };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/favicon.svg',
      data: { url: payload.url ?? '/', jobUrl: payload.jobUrl ?? payload.url ?? '/' },
      tag: payload.tag,
      renotify: payload.renotify ?? false,
      silent: payload.silent ?? false,
      actions: payload.actions ?? [],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'download') {
    event.waitUntil(self.clients.openWindow(event.notification.data?.url ?? '/'));
    return;
  }
  const targetUrl = event.action === 'open-job'
    ? event.notification.data?.jobUrl ?? '/'
    : event.notification.data?.jobUrl ?? event.notification.data?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.navigate(targetUrl).then(() => client.focus());
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
