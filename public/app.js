// Time Tracker frontend — Phase 6 scope: service worker + push subscription.
// Phase 7 will build the rest of the UI on top of this.

(function () {
  const pushSupported =
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  const enableBtn = document.getElementById('enable-notifications-btn');
  const banner = document.getElementById('notifications-banner');
  const statusEl = document.getElementById('notifications-status');

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
    else console.log('[push]', text);
  }

  function hideBanner() {
    if (banner) banner.hidden = true;
  }

  function showBanner() {
    if (banner) banner.hidden = false;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function getVapidPublicKey() {
    const res = await fetch('/api/push/vapid-public-key');
    if (!res.ok) throw new Error('vapid key fetch failed');
    const body = await res.json();
    if (!body.key) throw new Error('server has no VAPID key configured');
    return body.key;
  }

  async function saveSubscription(sub) {
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
    if (!res.ok) throw new Error('subscribe save failed');
    return res.json();
  }

  async function registerAndSubscribe() {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    let sub = await registration.pushManager.getSubscription();
    if (!sub) {
      const key = await getVapidPublicKey();
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    await saveSubscription(sub.toJSON ? sub.toJSON() : sub);
    return sub;
  }

  async function enableNotifications() {
    if (!pushSupported) {
      setStatus('Push notifications are not supported in this browser.');
      return;
    }
    try {
      setStatus('Requesting permission…');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus('Notifications permission denied.');
        showBanner();
        return;
      }
      setStatus('Subscribing…');
      await registerAndSubscribe();
      setStatus('Notifications enabled.');
      hideBanner();
    } catch (err) {
      console.error('[push] enable failed:', err);
      setStatus('Could not enable notifications: ' + (err.message || err));
      showBanner();
    }
  }

  async function init() {
    if (!pushSupported) {
      setStatus('Push notifications are not supported in this browser.');
      hideBanner();
      return;
    }

    if (Notification.permission === 'granted') {
      // Already granted — make sure the SW is registered and subscription is saved.
      try {
        await registerAndSubscribe();
        setStatus('Notifications enabled.');
        hideBanner();
      } catch (err) {
        console.error('[push] auto-subscribe failed:', err);
        setStatus('Notifications permission granted, but subscription failed.');
        showBanner();
      }
    } else {
      showBanner();
      setStatus('');
    }

    if (enableBtn) {
      enableBtn.addEventListener('click', enableNotifications);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
