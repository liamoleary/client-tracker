// Time Tracker — frontend

(function () {
  'use strict';

  const HOURS_PER_DAY = 8;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function formatSeconds(totalSec) {
    const s = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
  }

  function formatHM(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }

  function calcEarnings(seconds, dailyRate) {
    return (seconds / 3600) * (dailyRate / HOURS_PER_DAY);
  }

  function fmtMoney(dollars) {
    return '$' + dollars.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function fmtDate(isoStr) {
    return new Date(isoStr).toLocaleDateString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
    });
  }

  function fmtTime(isoStr) {
    return new Date(isoStr).toLocaleTimeString(undefined, {
      hour: '2-digit', minute: '2-digit',
    });
  }

  // Returns the ISO date string (YYYY-MM-DD) for the Monday of the week
  // containing the given date string.
  function weekKey(isoStr) {
    const d = new Date(isoStr);
    const day = d.getDay(); // 0=Sun
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setDate(monday.getDate() + diff);
    monday.setHours(0, 0, 0, 0);
    return monday.toISOString().slice(0, 10);
  }

  function weekLabel(weekStartIso) {
    const start = new Date(weekStartIso + 'T00:00:00');
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const fmt = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `${fmt(start)} – ${fmt(end)}`;
  }

  // Groups sessions by their Mon-start week. Returns [[weekKey, sessions[]]...]
  // sorted newest week first.
  function groupByWeek(sessions) {
    const map = new Map();
    for (const s of sessions) {
      const k = weekKey(s.start_time);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(s);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }

  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── State ────────────────────────────────────────────────────────────────

  let projects = [];        // [{ id, name, daily_rate, total_seconds }]
  let activeSession = null; // { id, project_id, start_time, project_name } | null
  let tickIntervalId = null;
  let expandedProjects = new Set(); // project ids currently showing details
  let projectSessions = {};         // { [projectId]: completedSession[] }

  // ── DOM refs ─────────────────────────────────────────────────────────────

  const activeBanner    = document.getElementById('active-banner');
  const bannerProject   = document.getElementById('banner-project');
  const bannerElapsed   = document.getElementById('banner-elapsed');
  const bannerStarted   = document.getElementById('banner-started');
  const bannerStopBtn   = document.getElementById('banner-stop-btn');

  const notifBanner     = document.getElementById('notifications-banner');
  const notifStatusEl   = document.getElementById('notifications-status');
  const enableNotifBtn  = document.getElementById('enable-notifications-btn');

  const newProjectInput = document.getElementById('new-project-input');
  const addProjectBtn   = document.getElementById('add-project-btn');
  const projectList     = document.getElementById('project-list');
  const emptyState      = document.getElementById('empty-state');

  // ── Timer ticker ─────────────────────────────────────────────────────────

  function startTick() {
    if (tickIntervalId) return;
    tickIntervalId = setInterval(() => {
      updateBanner();
      // Keep running session row live if its project is expanded.
      if (activeSession && expandedProjects.has(activeSession.project_id)) {
        updateRunningSessionRow();
      }
    }, 1000);
  }

  function stopTick() {
    if (tickIntervalId) { clearInterval(tickIntervalId); tickIntervalId = null; }
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
    bannerStarted.textContent =
      'Started ' + fmtDate(activeSession.start_time) + ' at ' + fmtTime(activeSession.start_time);
    activeBanner.classList.add('visible');
  }

  // Updates just the duration + earnings cells of the running session row
  // without re-rendering the whole list.
  function updateRunningSessionRow() {
    const row = document.querySelector('.session-item.running');
    if (!row || !activeSession) return;
    const elapsed = (Date.now() - new Date(activeSession.start_time).getTime()) / 1000;
    const proj = projects.find((p) => p.id === activeSession.project_id);
    const dur = row.querySelector('.session-duration');
    const earn = row.querySelector('.session-earnings');
    if (dur) dur.textContent = formatHM(elapsed);
    if (earn && proj) earn.textContent = fmtMoney(calcEarnings(elapsed, proj.daily_rate));
  }

  // ── Render project list ───────────────────────────────────────────────────

  function renderProjects() {
    const timerRunning = activeSession !== null;
    projectList.innerHTML = '';
    emptyState.hidden = projects.length > 0;

    projects.forEach((p) => {
      const isActive   = timerRunning && activeSession.project_id === p.id;
      const isExpanded = expandedProjects.has(p.id);

      const row = document.createElement('div');
      row.className = 'project-row' + (isActive ? ' active' : '') + (isExpanded ? ' expanded' : '');
      row.dataset.id = p.id;

      // ── Header ──
      const header = document.createElement('div');
      header.className = 'project-header';

      const info = document.createElement('div');
      info.className = 'project-info';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name;

      const stats = document.createElement('div');
      stats.className = 'stats';
      const activeSec = isActive
        ? Math.floor((Date.now() - new Date(activeSession.start_time).getTime()) / 1000)
        : 0;
      const totalSec = p.total_seconds + activeSec;
      const timeSpan = document.createElement('span');
      timeSpan.className = 'stat-time';
      timeSpan.textContent = formatHM(totalSec);
      const earnSpan = document.createElement('span');
      earnSpan.className = 'stat-earnings';
      earnSpan.textContent = fmtMoney(calcEarnings(totalSec, p.daily_rate));
      stats.appendChild(timeSpan);
      stats.appendChild(document.createTextNode(' · '));
      stats.appendChild(earnSpan);
      if (isActive) {
        const badge = document.createElement('span');
        badge.className = 'running-badge';
        badge.textContent = '● Running';
        stats.appendChild(badge);
      }

      info.appendChild(name);
      info.appendChild(stats);

      // ── Actions ──
      const actions = document.createElement('div');
      actions.className = 'project-actions';

      const expandBtn = document.createElement('button');
      expandBtn.className = 'btn-icon expand-btn';
      expandBtn.setAttribute('aria-label', isExpanded ? 'Collapse' : 'Expand details');
      expandBtn.textContent = isExpanded ? '▲' : '▼';
      expandBtn.addEventListener('click', () => toggleExpand(p.id));

      const timerBtn = document.createElement('button');
      if (isActive) {
        timerBtn.className = 'btn-danger';
        timerBtn.textContent = 'Stop';
        timerBtn.addEventListener('click', stopTimer);
      } else {
        timerBtn.className = 'btn-primary';
        timerBtn.textContent = 'Start';
        timerBtn.disabled = timerRunning;
        timerBtn.addEventListener('click', () => startTimer(p.id));
      }

      actions.appendChild(expandBtn);
      actions.appendChild(timerBtn);
      header.appendChild(info);
      header.appendChild(actions);
      row.appendChild(header);

      // ── Expanded details ──
      if (isExpanded) {
        row.appendChild(buildDetailsPanel(p));
      }

      projectList.appendChild(row);
    });
  }

  // ── Build expanded details panel ──────────────────────────────────────────

  function buildDetailsPanel(project) {
    const details = document.createElement('div');
    details.className = 'project-details';

    const completed = projectSessions[project.id] || [];

    // Splice in the active session (if running for this project) as a synthetic entry.
    const runningEntry = (activeSession && activeSession.project_id === project.id)
      ? { ...activeSession, _running: true }
      : null;
    const allSessions = runningEntry ? [runningEntry, ...completed] : completed;

    const weekGroups = groupByWeek(allSessions);

    // ── Invoice summary (last 2 weeks) ──
    if (weekGroups.length > 0) {
      const invoiceWeeks = weekGroups.slice(0, 2);
      const invoiceSec = invoiceWeeks
        .flatMap(([, s]) => s)
        .reduce((sum, s) => {
          const elapsed = s._running
            ? Math.floor((Date.now() - new Date(s.start_time).getTime()) / 1000)
            : (s.duration_seconds || 0);
          return sum + elapsed;
        }, 0);

      const earliestWk = invoiceWeeks[invoiceWeeks.length - 1][0];
      const latestWk   = invoiceWeeks[0][0];
      const rangeStart = new Date(earliestWk + 'T00:00:00');
      const rangeEnd   = new Date(latestWk   + 'T00:00:00');
      rangeEnd.setDate(rangeEnd.getDate() + 6);

      const fmtShort = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const fmtLong  = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

      const inv = document.createElement('div');
      inv.className = 'fortnight-block';
      const weeksLabel = invoiceWeeks.length >= 2 ? 'last 2 weeks' : 'this week';
      inv.innerHTML =
        `<div class="fortnight-label">Invoice — ${weeksLabel}</div>` +
        `<div class="fortnight-period">${fmtShort(rangeStart)} – ${fmtLong(rangeEnd)}</div>` +
        `<div class="fortnight-amount">${formatHM(invoiceSec)} &middot; <strong>${fmtMoney(calcEarnings(invoiceSec, project.daily_rate))}</strong></div>`;
      details.appendChild(inv);
    }

    // ── Rate row ──
    const rateRow = document.createElement('div');
    rateRow.className = 'rate-row';
    renderRateRow(rateRow, project);
    details.appendChild(rateRow);

    // ── Week groups ──
    if (weekGroups.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'no-sessions';
      empty.textContent = 'No sessions yet — start the timer or add time manually below.';
      details.appendChild(empty);
    } else {
      for (const [wk, wkSessions] of weekGroups) {
        const completedInWeek = wkSessions.filter((s) => !s._running);
        const weekSec = completedInWeek.reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
        const weekEarn = calcEarnings(weekSec, project.daily_rate);

        const group = document.createElement('div');
        group.className = 'week-group';

        const wkHeader = document.createElement('div');
        wkHeader.className = 'week-header';
        const totalLabel = document.createElement('span');
        totalLabel.className = 'week-label';
        totalLabel.textContent = weekLabel(wk);
        const totalRight = document.createElement('span');
        totalRight.className = 'week-total';
        totalRight.innerHTML =
          `${formatHM(weekSec)} &middot; <span class="week-total-earnings">${fmtMoney(weekEarn)}</span>`;
        wkHeader.appendChild(totalLabel);
        wkHeader.appendChild(totalRight);
        group.appendChild(wkHeader);

        for (const s of wkSessions) {
          const elapsed = s._running
            ? Math.floor((Date.now() - new Date(s.start_time).getTime()) / 1000)
            : (s.duration_seconds || 0);
          const earn = calcEarnings(elapsed, project.daily_rate);

          const item = document.createElement('div');
          item.className =
            'session-item' +
            (s._running   ? ' running'   : '') +
            (s.is_manual  ? ' is-manual' : '');

          const dateEl = document.createElement('span');
          dateEl.className = 'session-date';
          dateEl.textContent = fmtDate(s.start_time);

          const timeEl = document.createElement('span');
          timeEl.className = 'session-time';
          timeEl.textContent = s._running
            ? fmtTime(s.start_time) + ' – now'
            : fmtTime(s.start_time) + (s.end_time ? ' – ' + fmtTime(s.end_time) : '');

          const durEl = document.createElement('span');
          durEl.className = 'session-duration';
          durEl.textContent = formatHM(elapsed);

          const earnEl = document.createElement('span');
          earnEl.className = 'session-earnings';
          earnEl.textContent = fmtMoney(earn);

          item.appendChild(dateEl);
          item.appendChild(timeEl);
          item.appendChild(durEl);
          item.appendChild(earnEl);

          if (s._running) {
            const tag = document.createElement('span');
            tag.className = 'running-tag';
            tag.textContent = '● live';
            item.appendChild(tag);
          } else if (s.is_manual) {
            const tag = document.createElement('span');
            tag.className = 'manual-tag';
            tag.textContent = 'manual';
            item.appendChild(tag);
          }

          if (!s._running) {
            const del = document.createElement('button');
            del.className = 'session-delete';
            del.title = 'Delete this session';
            del.textContent = '×';
            del.addEventListener('click', () => deleteSession(s.id, project.id));
            item.appendChild(del);
          }

          group.appendChild(item);
        }

        details.appendChild(group);
      }
    }

    // ── Manual entry form ──
    const manualSection = document.createElement('div');
    manualSection.className = 'manual-entry';
    const today = new Date().toISOString().slice(0, 10);
    manualSection.innerHTML =
      `<div class="manual-title">+ Add time manually</div>` +
      `<form class="manual-form" autocomplete="off">` +
        `<input type="date" name="date" value="${today}" max="${today}" required />` +
        `<input type="number" name="hours" placeholder="h" min="0" max="23" />` +
        `<input type="number" name="minutes" placeholder="min" min="0" max="59" />` +
        `<button type="submit" class="btn-secondary">Add</button>` +
      `</form>`;

    manualSection.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const date    = f.elements.date.value;
      const hours   = parseInt(f.elements.hours.value   || '0', 10);
      const minutes = parseInt(f.elements.minutes.value || '0', 10);
      if (!date || (hours === 0 && minutes === 0)) {
        alert('Please enter a date and a non-zero duration.');
        return;
      }
      const btn = f.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        await addManualTime(project.id, date, hours, minutes);
        f.elements.hours.value   = '';
        f.elements.minutes.value = '';
      } finally {
        btn.disabled = false;
      }
    });

    details.appendChild(manualSection);
    return details;
  }

  // ── Rate row helpers ──────────────────────────────────────────────────────

  function renderRateRow(container, project) {
    container.innerHTML = '';
    const label = document.createElement('span');
    label.innerHTML = `<span>Day rate:</span> <span class="rate-value">$${Number(project.daily_rate).toLocaleString()}/day</span>`;
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-link';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => showRateEdit(container, project));
    container.appendChild(label);
    container.appendChild(editBtn);
  }

  function showRateEdit(container, project) {
    container.innerHTML = '';
    const form = document.createElement('form');
    form.className = 'rate-form';
    form.innerHTML =
      `<label>Day rate: $<input type="number" name="rate" value="${project.daily_rate}" min="0" step="1" /></label>` +
      `<button type="submit" class="btn-secondary">Save</button>` +
      `<button type="button" class="btn-link cancel-rate">Cancel</button>`;
    form.querySelector('.cancel-rate').addEventListener('click', () => renderRateRow(container, project));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rate = parseFloat(form.elements.rate.value);
      if (!isFinite(rate) || rate < 0) return;
      form.querySelector('[type="submit"]').disabled = true;
      await saveRate(project.id, rate, container);
    });
    container.appendChild(form);
  }

  // ── API actions ───────────────────────────────────────────────────────────

  async function loadAll() {
    const [p, a] = await Promise.all([
      api('GET', '/api/projects'),
      api('GET', '/api/timer/active'),
    ]);
    projects      = p;
    activeSession = a;

    if (activeSession) { updateBanner(); startTick(); }
    else { activeBanner.classList.remove('visible'); stopTick(); }

    renderProjects();
  }

  async function loadSessions(projectId) {
    const sessions = await api('GET', `/api/sessions/${projectId}`);
    projectSessions[projectId] = sessions;
  }

  async function toggleExpand(projectId) {
    if (expandedProjects.has(projectId)) {
      expandedProjects.delete(projectId);
      renderProjects();
    } else {
      expandedProjects.add(projectId);
      await loadSessions(projectId);
      renderProjects();
    }
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
      if (expandedProjects.has(projectId)) {
        await loadSessions(projectId);
        renderProjects();
      }
    } catch (err) {
      alert('Could not start timer: ' + err.message);
    }
  }

  async function stopTimer() {
    bannerStopBtn.disabled = true;
    const stoppedProjectId = activeSession?.project_id;
    try {
      await api('POST', '/api/timer/stop');
      activeSession = null;
      stopTick();
      activeBanner.classList.remove('visible');
      await loadAll();
      if (stoppedProjectId && expandedProjects.has(stoppedProjectId)) {
        await loadSessions(stoppedProjectId);
        renderProjects();
      }
    } catch (err) {
      alert('Could not stop timer: ' + err.message);
    } finally {
      bannerStopBtn.disabled = false;
    }
  }

  async function addManualTime(projectId, date, hours, minutes) {
    // Noon local time so it groups correctly regardless of timezone offset.
    const localNoon = new Date(`${date}T12:00:00`);
    try {
      await api('POST', '/api/sessions', {
        project_id: projectId,
        start_time: localNoon.toISOString(),
        hours,
        minutes,
      });
      const [allProjects] = await Promise.all([
        api('GET', '/api/projects'),
        loadSessions(projectId),
      ]);
      projects = allProjects;
      renderProjects();
    } catch (err) {
      alert('Could not add time: ' + err.message);
    }
  }

  async function deleteSession(sessionId, projectId) {
    if (!confirm('Delete this session?')) return;
    try {
      await api('DELETE', `/api/sessions/${sessionId}`);
      const [allProjects] = await Promise.all([
        api('GET', '/api/projects'),
        loadSessions(projectId),
      ]);
      projects = allProjects;
      renderProjects();
    } catch (err) {
      alert('Could not delete session: ' + err.message);
    }
  }

  async function saveRate(projectId, rate) {
    try {
      const updated = await api('PATCH', `/api/projects/${projectId}`, { daily_rate: rate });
      const idx = projects.findIndex((p) => p.id === projectId);
      if (idx !== -1) projects[idx].daily_rate = updated.daily_rate;
      renderProjects();
    } catch (err) {
      alert('Could not update rate: ' + err.message);
    }
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  addProjectBtn.addEventListener('click', addProject);
  newProjectInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addProject(); });
  bannerStopBtn.addEventListener('click', stopTimer);

  // ── Service worker registration (PWA install + offline shell) ────────────

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.error('[sw] registration failed:', err);
      });
    });
  }

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
