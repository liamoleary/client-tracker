// Service worker for the Time Tracker.
// Handles push notifications and notification action clicks.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

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
