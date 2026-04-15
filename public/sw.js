// Service worker for the Time Tracker.
// Responsibilities:
//  1. Cache the app shell so the app can launch from the home screen when
//     the device is offline or on a flaky connection.
//  2. Handle push notifications (hourly check-ins).
//  3. Respond to notification action clicks.

const CACHE_VERSION = 'tt-shell-v3';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable.png',
  '/apple-touch-icon.png',
];

// ── Lifecycle ────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// ── Fetch strategy ───────────────────────────────────────────────────────
//
// - API calls (/api/*) and the health endpoint always go to the network; we
//   never serve stale timer/project data from cache.
// - HTML navigations: network-first, falling back to the cached shell so the
//   app still opens from the home screen offline.
// - Everything else (static assets): cache-first, then network.

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE_VERSION);
          cache.put('/index.html', fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match('/index.html');
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok && fresh.type === 'basic') {
          const cache = await caches.open(CACHE_VERSION);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        return cached || Response.error();
      }
    })(),
  );
});

// ── Push notifications ───────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: 'Time Tracker', body: event.data.text() };
    }
  }

  const title = payload.title || 'Time Tracker';
  const options = {
    body: payload.body || '',
    data: payload.data || {},
    tag: 'time-tracker-checkin',
    renotify: true,
    requireInteraction: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    actions: [
      { action: 'confirm', title: 'Yes, still working' },
      { action: 'stop', title: 'No, stop timer' },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const action = event.action;

  event.waitUntil(
    (async () => {
      if (action === 'confirm') {
        try {
          await fetch('/api/timer/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err) {
          // Swallow — the notification is already dismissed.
        }
        return;
      }

      if (action === 'stop') {
        try {
          await fetch('/api/timer/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err) {
          // Swallow.
        }
        return;
      }

      // Tapping the body (no action) — focus/open the app.
      const clientsArr = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clientsArr) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })(),
  );
});
