// Time Tracker — frontend

(function () {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────────────────

  function formatSeconds(totalSec) {
    const s = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
  }

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── State ────────────────────────────────────────────────────────────────

  let projects = [];        // [{ id, name, total_seconds }]
  let activeSession = null; // { id, project_id, start_time, project_name } | null
  let tickIntervalId = null;

  // ── DOM refs ─────────────────────────────────────────────────────────────

  const activeBanner       = document.getElementById('active-banner');
  const bannerProject      = document.getElementById('banner-project');
  const bannerElapsed      = document.getElementById('banner-elapsed');
  const bannerStopBtn      = document.getElementById('banner-stop-btn');

  const notifBanner        = document.getElementById('notifications-banner');
  const notifStatusEl      = document.getElementById('notifications-status');
  const enableNotifBtn     = document.getElementById('enable-notifications-btn');

  const newProjectInput    = document.getElementById('new-project-input');
  const addProjectBtn      = document.getElementById('add-project-btn');
  const projectList        = document.getElementById('project-list');
  const emptyState         = document.getElementById('empty-state');

  // ── Timer ticker ─────────────────────────────────────────────────────────

  function startTick() {
    if (tickIntervalId) return;
    tickIntervalId = setInterval(updateBanner, 1000);
  }

  function stopTick() {
    if (tickIntervalId) {
      clearInterval(tickIntervalId);
      tickIntervalId = null;
    }
  }

  function updateBanner() {
    if (!activeSession) {
      activeBanner.classList.remove('visible');
      stopTick();
      return;
    }
    const elapsedSec = (Date.now() - new Date(activeSession.start_time).getTime()) / 1000;
    bannerProject.textContent = activeSession.project_name;
    bannerElapsed.textContent = formatSeconds(elapsedSec);
    activeBanner.classList.add('visible');
  }

  // ── Render project list ───────────────────────────────────────────────────

  function renderProjects() {
    const timerRunning = activeSession !== null;
    projectList.innerHTML = '';
    emptyState.hidden = projects.length > 0;

    projects.forEach((p) => {
      const isActive = timerRunning && activeSession.project_id === p.id;

      const row = document.createElement('div');
      row.className = 'project-row' + (isActive ? ' active' : '');
      row.dataset.id = p.id;

      const info = document.createElement('div');
      info.className = 'project-info';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name;

      const total = document.createElement('div');
      total.className = 'total';
      if (isActive) {
        const extra = Math.floor(
          (Date.now() - new Date(activeSession.start_time).getTime()) / 1000,
        );
        total.textContent = 'Total: ' + formatSeconds(p.total_seconds + extra) + ' (running)';
      } else {
        total.textContent = 'Total: ' + formatSeconds(p.total_seconds);
      }

      info.appendChild(name);
      info.appendChild(total);

      const btn = document.createElement('button');
      if (isActive) {
        btn.className = 'btn-danger';
        btn.textContent = 'Stop Timer';
        btn.addEventListener('click', () => stopTimer());
      } else {
        btn.className = 'btn-primary';
        btn.textContent = 'Start Timer';
        btn.disabled = timerRunning;
        btn.addEventListener('click', () => startTimer(p.id));
      }

      row.appendChild(info);
      row.appendChild(btn);
      projectList.appendChild(row);
    });
  }

  // ── API actions ───────────────────────────────────────────────────────────

  async function loadAll() {
    const [p, a] = await Promise.all([
      api('GET', '/api/projects'),
      api('GET', '/api/timer/active'),
    ]);
    projects = p;
    activeSession = a;

    if (activeSession) {
      updateBanner();
      startTick();
    } else {
      activeBanner.classList.remove('visible');
      stopTick();
    }
    renderProjects();
  }

  async function addProject() {
    const name = newProjectInput.value.trim();
    if (!name) return;
    addProjectBtn.disabled = true;
    try {
      await api('POST', '/api/projects', { name });
      newProjectInput.value = '';
      await loadAll();
    } catch (err) {
      alert('Could not add project: ' + err.message);
    } finally {
      addProjectBtn.disabled = false;
    }
  }

  async function startTimer(projectId) {
    try {
      const session = await api('POST', '/api/timer/start', { project_id: projectId });
      activeSession = { ...session };
      updateBanner();
      startTick();
      await loadAll();
    } catch (err) {
      alert('Could not start timer: ' + err.message);
    }
  }

  async function stopTimer() {
    bannerStopBtn.disabled = true;
    try {
      await api('POST', '/api/timer/stop');
      activeSession = null;
      stopTick();
      activeBanner.classList.remove('visible');
      await loadAll();
    } catch (err) {
      alert('Could not stop timer: ' + err.message);
    } finally {
      bannerStopBtn.disabled = false;
    }
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  addProjectBtn.addEventListener('click', addProject);

  newProjectInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addProject();
  });

  bannerStopBtn.addEventListener('click', stopTimer);

  // ── Push notifications ────────────────────────────────────────────────────

  const pushSupported =
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  function setNotifStatus(text) {
    notifStatusEl.textContent = text;
  }

  function urlBase64ToUint8Array(b64) {
    const padding = '='.repeat((4 - (b64.length % 4)) % 4);
    const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function registerAndSubscribe() {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await api('GET', '/api/push/vapid-public-key');
      if (!key) throw new Error('Server has no VAPID key configured.');
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    await api('POST', '/api/push/subscribe', sub.toJSON ? sub.toJSON() : sub);
  }

  async function enableNotifications() {
    if (!pushSupported) {
      setNotifStatus('Push notifications are not supported in this browser.');
      return;
    }
    try {
      setNotifStatus('Requesting permission…');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setNotifStatus('Notifications permission denied.');
        return;
      }
      setNotifStatus('Subscribing…');
      await registerAndSubscribe();
      setNotifStatus('Notifications enabled.');
      notifBanner.hidden = true;
    } catch (err) {
      console.error('[push]', err);
      setNotifStatus('Could not enable notifications: ' + (err.message || err));
    }
  }

  async function initPush() {
    if (!pushSupported) { notifBanner.hidden = true; return; }

    if (Notification.permission === 'granted') {
      try {
        await registerAndSubscribe();
        setNotifStatus('Notifications enabled.');
        notifBanner.hidden = true;
      } catch (err) {
        console.error('[push] auto-subscribe failed:', err);
        notifBanner.hidden = false;
      }
    } else {
      notifBanner.hidden = false;
    }

    enableNotifBtn.addEventListener('click', enableNotifications);
  }

  // ── Boot ─────────────────────────────────────────────────────────────────

  loadAll().catch(console.error);
  initPush().catch(console.error);
})();
