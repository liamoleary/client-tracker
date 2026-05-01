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

  // Converts seconds into days, where 1 day = HOURS_PER_DAY hours (8).
  // Returns a single-decimal string like "2.5d" / "0d".
  function formatDays(seconds) {
    const days = Math.max(0, seconds) / (HOURS_PER_DAY * 3600);
    return days.toFixed(1) + 'd';
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

  // "YYYY-MM-DD" in the user's local tz — used for grouping sessions into
  // billable work-days consistently with what the rest of the UI displays.
  function localDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  function ordinal(n) {
    const rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return n + 'th';
    switch (n % 10) {
      case 1: return n + 'st';
      case 2: return n + 'nd';
      case 3: return n + 'rd';
      default: return n + 'th';
    }
  }

  // "25th March 2026" — matches the user's Xero invoice line-item format.
  function formatOrdinalDate(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const monthName = date.toLocaleDateString(undefined, { month: 'long' });
    return `${ordinal(d)} ${monthName} ${y}`;
  }

  // Returns the 10 Mon-Fri date keys spanning a fortnight that starts on a
  // Monday. Used as the slot grid in the invoice planner — each slot is one
  // 8h day the user can choose to bill for.
  function fortnightWeekdays(periodStart) {
    const out = [];
    for (let i = 0; i < 14; i++) {
      const d = addDays(periodStart, i);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) out.push(localDateKey(d));
    }
    return out;
  }

  function formatInvoicePeriod(startDate, endDate) {
    const shortOpts = { day: 'numeric', month: 'short' };
    const longOpts  = { day: 'numeric', month: 'short', year: 'numeric' };
    return (
      startDate.toLocaleDateString(undefined, shortOpts) +
      ' – ' +
      endDate.toLocaleDateString(undefined, longOpts)
    );
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
  let invoiceAnchor = null;         // "YYYY-MM-DD" — last Sunday we've invoiced through, or null.
  let invoiceSessions = [];         // raw sessions since the anchor (for fortnight rollup).
  let invoiceProjectsMeta = {};     // { [projectId]: { hours_banked_seconds } } from the server.
  // { [projectId]: Set<dateKey> } — weekdays the user has marked as a
  // billable 8h day for this fortnight. Lives in memory until mark-as-invoiced.
  let invoiceSelectedDays = {};
  let invoiceHistory = [];          // [{ id, period_start, period_end, sent_at, total_amount, line_items[] }]
  let expandedInvoices = new Set(); // invoice ids currently showing line items

  // ── DOM refs ─────────────────────────────────────────────────────────────

  const activeBanner    = document.getElementById('active-banner');
  const bannerProject   = document.getElementById('banner-project');
  const bannerElapsed   = document.getElementById('banner-elapsed');
  const bannerStarted   = document.getElementById('banner-started');
  const bannerStopBtn   = document.getElementById('banner-stop-btn');

  const notifBanner     = document.getElementById('notifications-banner');
  const notifStatusEl   = document.getElementById('notifications-status');
  const enableNotifBtn  = document.getElementById('enable-notifications-btn');

  // Home-page summary card.
  const invoiceCard         = document.getElementById('invoice-card');
  const invoiceCardPeriodEl = document.getElementById('invoice-card-period');
  const invoiceCardStatusEl = document.getElementById('invoice-card-status');
  const invoiceCardTotalEl  = document.getElementById('invoice-card-total');
  const invoiceCardMetaEl   = document.getElementById('invoice-card-meta');
  const invoicePlanBtn      = document.getElementById('invoice-plan-btn');
  const invoiceSettingsBtn  = document.getElementById('invoice-settings-btn');

  // Full-screen planner page.
  const invoicePlannerPage    = document.getElementById('invoice-planner-page');
  const invoicePlannerBackBtn = document.getElementById('invoice-planner-back');
  const invoicePlannerPeriod  = document.getElementById('invoice-planner-period');
  const invoicePlannerGrand   = document.getElementById('invoice-planner-grand-total');
  const invoicePlannerBodyEl  = document.getElementById('invoice-planner-body');
  const invoicePlannerCopyBtn = document.getElementById('invoice-planner-copy');
  const invoicePlannerSaveBtn = document.getElementById('invoice-planner-save');

  const invoiceSetup        = document.getElementById('invoice-setup');
  const invoiceSetupForm    = document.getElementById('invoice-setup-form');
  const invoiceSetupDate    = document.getElementById('invoice-setup-date');
  const invoiceSetupDismiss = document.getElementById('invoice-setup-dismiss');

  const bankedSection     = document.getElementById('banked-section');
  const bankedListEl      = document.getElementById('banked-list');
  const invoiceRewindBtn  = document.getElementById('invoice-rewind-btn');
  const historySection    = document.getElementById('invoice-history-section');
  const historyListEl     = document.getElementById('invoice-history-list');

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
          `${formatHM(weekSec)} &middot; <span class="week-total-days">${formatDays(weekSec)}</span> &middot; <span class="week-total-earnings">${fmtMoney(weekEarn)}</span>`;
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
            const edit = document.createElement('button');
            edit.className = 'session-edit';
            edit.title = 'Edit session duration';
            edit.textContent = '✎';
            edit.addEventListener('click', () => showEditSessionModal(s, project.id));
            item.appendChild(edit);

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
    loadInvoiceStatus().catch(console.error);
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

  function stopTimer() {
    showStopConfirmModal();
  }

  async function confirmStop(durationSeconds) {
    bannerStopBtn.disabled = true;
    const stoppedProjectId = activeSession?.project_id;
    try {
      await api('POST', '/api/timer/stop', { duration_seconds: durationSeconds });
      activeSession = null;
      stopTick();
      activeBanner.classList.remove('visible');
      await loadAll();
      if (stoppedProjectId && expandedProjects.has(stoppedProjectId)) {
        await loadSessions(stoppedProjectId);
        renderProjects();
      }
    } catch (err) {
      // The server may have already closed the session (2h idle auto-stop, or
      // a "No, stop timer" tap on a check-in notification). Resync rather than
      // leaving the banner on a timer that no longer exists.
      if (/no timer is running/i.test(err.message)) {
        activeSession = null;
        stopTick();
        activeBanner.classList.remove('visible');
        await loadAll();
        if (stoppedProjectId && expandedProjects.has(stoppedProjectId)) {
          await loadSessions(stoppedProjectId);
          renderProjects();
        }
        alert(
          'That timer had already been stopped on the server — likely by the 2-hour idle auto-stop or a tap on "No, stop timer" in a check-in notification. The list has been refreshed; tap ✎ on the latest session if you need to adjust its duration.',
        );
      } else {
        alert('Could not stop timer: ' + err.message);
      }
    } finally {
      bannerStopBtn.disabled = false;
    }
  }

  async function editSessionDuration(sessionId, projectId, durationSeconds) {
    try {
      await api('PATCH', `/api/sessions/${sessionId}`, { duration_seconds: durationSeconds });
      const [allProjects] = await Promise.all([
        api('GET', '/api/projects'),
        loadSessions(projectId),
      ]);
      projects = allProjects;
      renderProjects();
      loadInvoiceStatus().catch(console.error);
    } catch (err) {
      alert('Could not update session: ' + err.message);
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
      loadInvoiceStatus().catch(console.error);
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
      loadInvoiceStatus().catch(console.error);
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
      loadInvoiceStatus().catch(console.error);
    } catch (err) {
      alert('Could not update rate: ' + err.message);
    }
  }

  // ── Modal ─────────────────────────────────────────────────────────────────

  // Generic modal: renders content into a centered overlay.
  // Returns { overlay, close }.
  function openModal(buildContent) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'modal-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    buildContent(dialog);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();

    // Close on backdrop click
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    // Close on Escape
    const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    return { overlay, close };
  }

  // Shows the stop confirmation modal. Calls confirmStop(durationSeconds) when confirmed.
  function showStopConfirmModal() {
    if (!activeSession) return;
    const elapsedSec = Math.max(0, Math.round((Date.now() - new Date(activeSession.start_time).getTime()) / 1000));

    openModal((dialog) => {
      let adjustedSec = elapsedSec;

      dialog.innerHTML =
        `<h2 class="modal-title">Stop timer?</h2>` +
        `<p class="modal-subtitle"><span class="modal-project">${activeSession.project_name}</span></p>` +
        `<div class="modal-time-display" id="modal-time-display">${formatSeconds(adjustedSec)}</div>` +
        `<p class="modal-hint">Adjust the time to log if needed:</p>` +
        `<div class="modal-adjust-row">` +
          `<button class="btn-secondary modal-adj" data-delta="-3600">−1h</button>` +
          `<button class="btn-secondary modal-adj" data-delta="-900">−15m</button>` +
          `<button class="btn-secondary modal-adj" data-delta="900">+15m</button>` +
          `<button class="btn-secondary modal-adj" data-delta="3600">+1h</button>` +
        `</div>` +
        `<div class="modal-manual-row">` +
          `<label class="modal-label">Or set directly: ` +
            `<input type="number" id="modal-hours" class="modal-num-input" min="0" max="999" placeholder="h" />` +
            `<span class="modal-sep">h</span>` +
            `<input type="number" id="modal-minutes" class="modal-num-input" min="0" max="59" placeholder="m" />` +
            `<span class="modal-sep">m</span>` +
          `</label>` +
        `</div>` +
        `<div class="modal-actions">` +
          `<button class="btn-danger" id="modal-confirm-stop">Stop &amp; Log</button>` +
          `<button class="btn-link" id="modal-cancel">Keep running</button>` +
        `</div>`;

      const display  = dialog.querySelector('#modal-time-display');
      const hoursEl  = dialog.querySelector('#modal-hours');
      const minsEl   = dialog.querySelector('#modal-minutes');

      function syncDisplay() {
        display.textContent = formatSeconds(adjustedSec);
        hoursEl.value  = Math.floor(adjustedSec / 3600);
        minsEl.value   = Math.floor((adjustedSec % 3600) / 60);
      }
      syncDisplay();

      // Adjust buttons
      dialog.querySelectorAll('.modal-adj').forEach((btn) => {
        btn.addEventListener('click', () => {
          adjustedSec = Math.max(60, adjustedSec + Number(btn.dataset.delta));
          syncDisplay();
        });
      });

      // Manual h/m inputs
      function onManualInput() {
        const h = Math.max(0, parseInt(hoursEl.value  || '0', 10));
        const m = Math.max(0, Math.min(59, parseInt(minsEl.value || '0', 10)));
        const total = h * 3600 + m * 60;
        if (total > 0) {
          adjustedSec = total;
          display.textContent = formatSeconds(adjustedSec);
        }
      }
      hoursEl.addEventListener('input', onManualInput);
      minsEl.addEventListener('input', onManualInput);

      let modal;
      dialog.querySelector('#modal-cancel').addEventListener('click', () => modal.close());
      dialog.querySelector('#modal-confirm-stop').addEventListener('click', async () => {
        modal.close();
        await confirmStop(Math.max(60, adjustedSec));
      });

      // Assign so the cancel button can close it
      modal = { close: () => dialog.closest('.modal-overlay').remove() };
    });
  }

  // Shows an edit-duration modal for a completed session.
  function showEditSessionModal(session, projectId) {
    openModal((dialog) => {
      const currentSec = session.duration_seconds || 0;

      dialog.innerHTML =
        `<h2 class="modal-title">Edit session time</h2>` +
        `<p class="modal-subtitle">${fmtDate(session.start_time)}` +
          (session.end_time ? ` &nbsp;${fmtTime(session.start_time)} – ${fmtTime(session.end_time)}` : '') +
        `</p>` +
        `<div class="modal-time-display" id="edit-time-display">${formatSeconds(currentSec)}</div>` +
        `<div class="modal-adjust-row">` +
          `<button class="btn-secondary modal-adj" data-delta="-3600">−1h</button>` +
          `<button class="btn-secondary modal-adj" data-delta="-900">−15m</button>` +
          `<button class="btn-secondary modal-adj" data-delta="900">+15m</button>` +
          `<button class="btn-secondary modal-adj" data-delta="3600">+1h</button>` +
        `</div>` +
        `<div class="modal-manual-row">` +
          `<label class="modal-label">Set duration: ` +
            `<input type="number" id="edit-hours" class="modal-num-input" min="0" max="999" />` +
            `<span class="modal-sep">h</span>` +
            `<input type="number" id="edit-minutes" class="modal-num-input" min="0" max="59" />` +
            `<span class="modal-sep">m</span>` +
          `</label>` +
        `</div>` +
        `<div class="modal-actions">` +
          `<button class="btn-primary" id="edit-confirm">Save</button>` +
          `<button class="btn-link" id="edit-cancel">Cancel</button>` +
        `</div>`;

      const display  = dialog.querySelector('#edit-time-display');
      const hoursEl  = dialog.querySelector('#edit-hours');
      const minsEl   = dialog.querySelector('#edit-minutes');
      let adjustedSec = currentSec;

      function syncDisplay() {
        display.textContent = formatSeconds(adjustedSec);
        hoursEl.value = Math.floor(adjustedSec / 3600);
        minsEl.value  = Math.floor((adjustedSec % 3600) / 60);
      }
      syncDisplay();

      dialog.querySelectorAll('.modal-adj').forEach((btn) => {
        btn.addEventListener('click', () => {
          adjustedSec = Math.max(60, adjustedSec + Number(btn.dataset.delta));
          syncDisplay();
        });
      });

      function onManualInput() {
        const h = Math.max(0, parseInt(hoursEl.value  || '0', 10));
        const m = Math.max(0, Math.min(59, parseInt(minsEl.value || '0', 10)));
        const total = h * 3600 + m * 60;
        if (total > 0) {
          adjustedSec = total;
          display.textContent = formatSeconds(adjustedSec);
        }
      }
      hoursEl.addEventListener('input', onManualInput);
      minsEl.addEventListener('input', onManualInput);

      let modal;
      dialog.querySelector('#edit-cancel').addEventListener('click', () => modal.close());
      dialog.querySelector('#edit-confirm').addEventListener('click', async () => {
        const secs = Math.max(60, adjustedSec);
        modal.close();
        await editSessionDuration(session.id, projectId, secs);
      });

      modal = { close: () => dialog.closest('.modal-overlay').remove() };
    });
  }

  // ── Invoice reminder ─────────────────────────────────────────────────────
  //
  // Anchor = "YYYY-MM-DD" of the last Sunday we've invoiced through. The
  // "current fortnight" is anchor+1 (Monday) through anchor+14 (Sunday).
  // We show the invoice-due banner when today's local date is strictly after
  // the period end (i.e. the fortnight has fully closed).

  function computeInvoicePeriod(anchorStr) {
    const anchor = new Date(anchorStr + 'T00:00:00');
    if (isNaN(anchor.getTime())) return null;
    const start = addDays(anchor, 1);
    const end = addDays(anchor, 14);
    const todayKey = localDateKey(new Date());
    const endKey   = localDateKey(end);
    return { start, end, due: todayKey > endKey };
  }

  // Fortnight rollup with banking:
  //   • tracked_seconds  = time tracked in the period
  //   • banked_seconds   = carry-in from prior invoices (positive = credit)
  //   • total_seconds    = tracked + banked → the pool of chargeable time
  //   • weekdayKeys      = the 10 Mon–Fri slots in the fortnight
  //   • maxDays          = floor(total_seconds / 8h), capped at 10 — hard
  //                        ceiling so we never bill more hours than we have
  //   • selectedDates    = which weekday slots the user has marked billable;
  //                        defaults to the first maxDays slots in date order
  //   • days             = selectedDates.size
  //   • bankedOut        = total_seconds − days × 8h    (rolls forward)
  //
  // A project appears in the breakdown if it has tracked time in the period
  // OR a non-zero banked balance (so old bank dust doesn't get stranded).
  function computeInvoiceBreakdown(sessions, period) {
    const startKey = localDateKey(period.start);
    const endKey   = localDateKey(period.end);
    const byProject = new Map();

    for (const s of sessions) {
      if (!s.duration_seconds || s.duration_seconds <= 0) continue;
      const key = localDateKey(new Date(s.start_time));
      if (key < startKey || key > endKey) continue;
      let entry = byProject.get(s.project_id);
      if (!entry) {
        entry = {
          id: s.project_id,
          name: s.project_name,
          daily_rate: Number(s.daily_rate) || 0,
          secondsByDate: {},
        };
        byProject.set(s.project_id, entry);
      }
      entry.secondsByDate[key] = (entry.secondsByDate[key] || 0) + s.duration_seconds;
    }

    // Fold in projects that have no tracked time this fortnight but do have a
    // non-zero banked balance — otherwise the user has no way to draw it down.
    for (const p of (projects || [])) {
      const meta = invoiceProjectsMeta[p.id];
      const banked = Number(meta?.hours_banked_seconds) || 0;
      if (!byProject.has(p.id) && banked !== 0) {
        byProject.set(p.id, {
          id: p.id,
          name: p.name,
          daily_rate: Number(p.daily_rate) || 0,
          secondsByDate: {},
        });
      }
    }

    const perDay = HOURS_PER_DAY * 3600;
    const weekdayKeys = fortnightWeekdays(period.start);

    const entries = [...byProject.values()]
      .map((p) => {
        const dates = Object.keys(p.secondsByDate).sort();
        const trackedSeconds = dates.reduce((t, k) => t + p.secondsByDate[k], 0);
        const bankedIn = Number(invoiceProjectsMeta[p.id]?.hours_banked_seconds) || 0;
        const totalSeconds = trackedSeconds + bankedIn;
        // Hard cap on billable days: floor(pool/8h), and never more than the
        // 10 weekday slots available. Anything left over banks forward.
        const maxDays = Math.max(0, Math.min(weekdayKeys.length, Math.floor(totalSeconds / perDay)));

        // Selected slots default to the first maxDays weekdays in date order
        // (so the auto-suggestion fills Mon→Fri, week 1 → week 2). The user
        // can click cells to swap which days are billed.
        let selectedDates = invoiceSelectedDays[p.id];
        if (selectedDates instanceof Set) {
          // Drop any selections that aren't in this period's weekday list
          // (e.g. period changed) and cap at maxDays. Sort by date key so
          // the cap is deterministic (keeps the earliest weekdays).
          const valid = [...selectedDates]
            .filter((k) => weekdayKeys.includes(k))
            .sort();
          selectedDates = new Set(valid.slice(0, maxDays));
        } else {
          selectedDates = new Set(weekdayKeys.slice(0, maxDays));
        }
        invoiceSelectedDays[p.id] = selectedDates;

        const days = selectedDates.size;
        const bankedOut = totalSeconds - days * perDay;
        return {
          id: p.id,
          name: p.name,
          daily_rate: p.daily_rate,
          dates,
          secondsByDate: p.secondsByDate,
          trackedSeconds,
          bankedIn,
          totalSeconds,
          weekdayKeys,
          selectedDates,
          maxDays,
          days,
          bankedOut,
          amount: days * p.daily_rate,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const total = entries.reduce((s, e) => s + e.amount, 0);
    return { entries, total };
  }

  // Running total for the in-progress fortnight: tracked time × hourly-rate
  // equivalent (daily_rate / 8), summed across projects. Uses the same math
  // as the per-week earnings line so the headline figure matches what the
  // user already sees elsewhere — no whole-day rounding, no projection.
  function computeInvoiceRunningTotal(sessions, period) {
    const startKey = localDateKey(period.start);
    const endKey   = localDateKey(period.end);
    let totalAmount = 0;
    let totalSeconds = 0;
    for (const s of sessions) {
      if (!s.duration_seconds || s.duration_seconds <= 0) continue;
      const key = localDateKey(new Date(s.start_time));
      if (key < startKey || key > endKey) continue;
      totalAmount  += calcEarnings(s.duration_seconds, Number(s.daily_rate) || 0);
      totalSeconds += s.duration_seconds;
    }

    // Banked carry-in across all projects, valued at each project's hourly
    // rate. Always non-negative — represents unbilled hours rolling into
    // the next invoice's pool.
    let bankedSeconds = 0;
    let bankedAmount = 0;
    for (const p of (projects || [])) {
      const meta = invoiceProjectsMeta[p.id];
      const sec = Math.max(0, Number(meta?.hours_banked_seconds) || 0);
      if (sec === 0) continue;
      bankedSeconds += sec;
      bankedAmount  += calcEarnings(sec, Number(p.daily_rate) || 0);
    }

    return {
      totalAmount,
      totalSeconds,
      bankedSeconds,
      bankedAmount,
    };
  }

  async function loadInvoiceStatus() {
    try {
      const s = await api('GET', '/api/invoice/status');
      invoiceAnchor = s.anchor || null;
      invoiceSessions = s.sessions || [];
      invoiceProjectsMeta = {};
      for (const p of (s.projects || [])) {
        invoiceProjectsMeta[p.id] = {
          hours_banked_seconds: Number(p.hours_banked_seconds) || 0,
          name: p.name,
        };
      }
    } catch (err) {
      console.warn('[invoice] failed to load status:', err);
      invoiceAnchor = null;
      invoiceSessions = [];
      invoiceProjectsMeta = {};
    }
    renderInvoice();
    renderBanked();
    loadInvoiceHistory().catch(console.error);
  }

  async function loadInvoiceHistory() {
    try {
      const s = await api('GET', '/api/invoice/history');
      invoiceHistory = s.invoices || [];
    } catch (err) {
      console.warn('[invoice] failed to load history:', err);
      invoiceHistory = [];
    }
    renderInvoiceHistory();
  }

  function renderBanked() {
    const rows = [];
    for (const id of Object.keys(invoiceProjectsMeta)) {
      const meta = invoiceProjectsMeta[id];
      const sec = Math.max(0, Number(meta.hours_banked_seconds) || 0);
      if (sec === 0) continue;
      const proj = projects.find((p) => String(p.id) === String(id));
      rows.push({ id, name: meta.name || proj?.name || ('Project ' + id), sec });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));

    // Show the section whenever an invoice anchor is set (so the user can
    // always reach the Redo-last-fortnight button), or when any banked
    // balance is non-zero.
    if (rows.length === 0 && !invoiceAnchor) {
      bankedSection.hidden = true;
      return;
    }

    bankedListEl.innerHTML = '';
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'banked-hint';
      empty.style.padding = '0.25rem 0';
      empty.textContent = 'No banked hours — everything tracked has been invoiced.';
      bankedListEl.appendChild(empty);
    } else {
      for (const r of rows) {
        const row = document.createElement('div');
        row.className = 'banked-row';
        const name = document.createElement('span');
        name.className = 'banked-name';
        name.textContent = r.name;
        const val = document.createElement('span');
        val.className = 'banked-value ' + (r.sec > 0 ? 'positive' : 'zero');
        val.textContent = formatHM(r.sec);
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'banked-edit';
        edit.textContent = 'Edit';
        edit.setAttribute('aria-label', 'Edit banked hours for ' + r.name);
        edit.addEventListener('click', () => editBankedHours(r));
        row.appendChild(name);
        row.appendChild(val);
        row.appendChild(edit);
        bankedListEl.appendChild(row);
      }
    }
    bankedSection.hidden = false;
  }

  async function editBankedHours(row) {
    const currentHours = (row.sec / 3600).toFixed(2);
    const input = prompt(
      'Hours still chargeable for "' + row.name + '":',
      currentHours,
    );
    if (input === null) return;
    const hrs = Number(input);
    if (!Number.isFinite(hrs) || hrs < 0) {
      alert('Enter a non-negative number, e.g. 2.5');
      return;
    }
    try {
      await api('POST', '/api/invoice/banked', {
        project_id: Number(row.id),
        hours_banked_seconds: Math.round(hrs * 3600),
      });
      await loadInvoiceStatus();
    } catch (err) {
      alert('Could not update: ' + err.message);
    }
  }

  async function rewindInvoice() {
    const confirmed = confirm(
      "Roll the invoice reminder back to the previous fortnight?\n\n" +
      "If that invoice is in your history, it'll be removed and its banked-hours adjustments reversed. " +
      "If it pre-dates the history (like your very first invoice), banking won't be touched — " +
      "you can use the Edit buttons to fix up balances after re-marking.",
    );
    if (!confirmed) return;
    invoiceRewindBtn.disabled = true;
    try {
      await api('POST', '/api/invoice/rewind', {});
      await loadInvoiceStatus();
    } catch (err) {
      alert('Could not rewind: ' + err.message);
    } finally {
      invoiceRewindBtn.disabled = false;
    }
  }

  function renderInvoiceHistory() {
    if (invoiceHistory.length === 0) {
      historySection.hidden = true;
      return;
    }
    historyListEl.innerHTML = '';
    for (const inv of invoiceHistory) {
      historyListEl.appendChild(buildInvoiceHistoryRow(inv));
    }
    historySection.hidden = false;
  }

  function buildInvoiceHistoryRow(inv) {
    const row = document.createElement('div');
    row.className = 'invoice-history-row';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'invoice-history-head';
    head.setAttribute('aria-expanded', 'false');

    const left = document.createElement('div');
    left.className = 'invoice-history-head-left';

    const caret = document.createElement('span');
    caret.className = 'invoice-caret';
    caret.textContent = '▸';
    caret.setAttribute('aria-hidden', 'true');

    const label = document.createElement('div');
    const periodStart = new Date(inv.period_start + 'T00:00:00');
    const periodEnd   = new Date(inv.period_end   + 'T00:00:00');
    const period = document.createElement('div');
    period.className = 'invoice-history-period';
    period.textContent = formatInvoicePeriod(periodStart, periodEnd);
    const sent = document.createElement('div');
    sent.className = 'invoice-history-sent';
    sent.textContent = 'Marked invoiced ' + formatSentAt(inv.sent_at);
    label.appendChild(period);
    label.appendChild(sent);

    left.appendChild(caret);
    left.appendChild(label);

    const total = document.createElement('div');
    total.className = 'invoice-history-total';
    total.textContent = fmtMoney(inv.total_amount);

    head.appendChild(left);
    head.appendChild(total);

    const body = document.createElement('div');
    body.className = 'invoice-history-body';
    body.hidden = !expandedInvoices.has(inv.id);

    if (inv.line_items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'invoice-history-empty';
      empty.textContent = 'No line items (empty fortnight).';
      body.appendChild(empty);
    } else {
      for (const l of inv.line_items) {
        const lineRow = document.createElement('div');
        lineRow.className = 'invoice-history-line';
        const nm = document.createElement('span');
        nm.className = 'invoice-history-line-name';
        nm.textContent = l.project_name +
          ' — ' + l.invoiced_days + (l.invoiced_days === 1 ? ' day' : ' days');
        const amt = document.createElement('span');
        amt.className = 'invoice-history-total';
        amt.textContent = fmtMoney(l.amount);
        lineRow.appendChild(nm);
        lineRow.appendChild(amt);
        body.appendChild(lineRow);

        const detail = document.createElement('div');
        detail.className = 'invoice-history-line-detail';
        const inPart  = l.banked_in_seconds  === 0 ? '' : ' + banked ' + formatSignedHM(l.banked_in_seconds);
        const outPart = ' · carried forward ' + formatSignedHM(l.banked_out_seconds);
        detail.textContent = formatHM(l.tracked_seconds) + ' tracked' + inPart + outPart;
        body.appendChild(detail);
      }
    }

    if (expandedInvoices.has(inv.id)) {
      row.classList.add('expanded');
      caret.textContent = '▾';
      head.setAttribute('aria-expanded', 'true');
    }

    head.addEventListener('click', () => {
      if (expandedInvoices.has(inv.id)) {
        expandedInvoices.delete(inv.id);
      } else {
        expandedInvoices.add(inv.id);
      }
      renderInvoiceHistory();
    });

    row.appendChild(head);
    row.appendChild(body);
    return row;
  }

  function formatSentAt(iso) {
    if (!iso) return '';
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function renderInvoice() {
    // No anchor → show the one-time setup prompt so the user can opt in.
    if (!invoiceAnchor) {
      invoiceCard.hidden = true;
      invoiceSetup.hidden = false;
      closeInvoicePlanner();
      return;
    }

    const period = computeInvoicePeriod(invoiceAnchor);
    invoiceSetup.hidden = true;

    if (!period) {
      invoiceCard.hidden = true;
      closeInvoicePlanner();
      return;
    }

    const breakdown = computeInvoiceBreakdown(invoiceSessions, period);

    // ── Home-page summary card ──
    invoiceCardPeriodEl.textContent = formatInvoicePeriod(period.start, period.end);
    invoiceCardStatusEl.textContent = describePeriodStatus(period);
    invoiceCardTotalEl.textContent  = fmtMoney(breakdown.total);
    invoiceCardMetaEl.textContent   = buildCardMetaText(breakdown);
    invoiceCard.hidden = false;

    // ── Planner page (only re-render if it's currently open) ──
    if (!invoicePlannerPage.hidden) {
      renderInvoicePlannerBody(period, breakdown);
    }
  }

  function renderInvoicePlannerBody(period, breakdown) {
    invoicePlannerPeriod.textContent = formatInvoicePeriod(period.start, period.end);
    invoicePlannerGrand.textContent  = fmtMoney(breakdown.total);

    invoicePlannerBodyEl.innerHTML = '';
    if (breakdown.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'invoice-project-meta';
      empty.textContent = 'No tracked work or banked hours in this period.';
      invoicePlannerBodyEl.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'invoice-breakdown';
      for (const e of breakdown.entries) {
        list.appendChild(buildInvoiceProjectRow(e));
      }
      invoicePlannerBodyEl.appendChild(list);
    }

    // Stash data the save / copy buttons need.
    invoicePlannerBodyEl.dataset.throughDate = localDateKey(period.end);
    invoicePlannerBodyEl.dataset.lineItems = breakdown.entries
      .filter((e) => e.days > 0)
      .map((e) => {
        const dates = [...e.selectedDates].sort();
        return dates
          .map((d) =>
            e.name + ' — ' + formatOrdinalDate(d) + ': ' + fmtMoney(e.daily_rate),
          )
          .join('\n');
      })
      .join('\n');
    invoicePlannerBodyEl.dataset.invoicedPayload = JSON.stringify(
      breakdown.entries.map((e) => ({
        project_id: e.id,
        tracked_seconds: Math.round(e.trackedSeconds),
        invoiced_days: e.days,
      })),
    );

    const noBilling = breakdown.entries.every((e) => e.days === 0);
    invoicePlannerCopyBtn.disabled = noBilling;
    invoicePlannerSaveBtn.textContent = period.due
      ? 'Save & process invoice'
      : 'Save & process invoice now';
  }

  function describePeriodStatus(period) {
    const todayKey = localDateKey(new Date());
    const endKey = localDateKey(period.end);
    if (todayKey > endKey) return 'Ready to bill — period closed';
    if (todayKey === endKey) return 'Ready to bill — final day';
    const msPerDay = 86400000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(period.end);
    end.setHours(0, 0, 0, 0);
    const days = Math.max(0, Math.round((end - today) / msPerDay));
    return 'In progress · ' + days + (days === 1 ? ' day' : ' days') + ' left';
  }

  function buildCardMetaText(breakdown) {
    if (breakdown.entries.length === 0) return '';
    const trackedTotal  = breakdown.entries.reduce((s, e) => s + e.trackedSeconds, 0);
    const bankedInTotal = breakdown.entries.reduce((s, e) => s + e.bankedIn, 0);
    const daysTotal     = breakdown.entries.reduce((s, e) => s + e.days, 0);
    const bankedOutSec  = breakdown.entries.reduce((s, e) => s + e.bankedOut, 0);
    const tracked = formatHM(trackedTotal);
    const inPart  = bankedInTotal > 0 ? ' + ' + formatHM(bankedInTotal) + ' banked' : '';
    const head    = tracked + ' tracked' + inPart;
    if (daysTotal === 0 && bankedOutSec === 0) return head;
    const carry = bankedOutSec > 0
      ? ' · ' + formatHM(bankedOutSec) + ' banks forward'
      : '';
    return head + ' · ' + daysTotal + ' × 8h day' + (daysTotal === 1 ? '' : 's') + carry;
  }

  function openInvoicePlanner() {
    if (!invoiceAnchor) return;
    document.body.classList.add('planner-open');
    invoicePlannerPage.hidden = false;
    // Force re-render so the planner body fills in.
    renderInvoice();
    // Send focus to the back button for keyboard users.
    if (invoicePlannerBackBtn) invoicePlannerBackBtn.focus();
  }

  function closeInvoicePlanner() {
    document.body.classList.remove('planner-open');
    if (invoicePlannerPage) invoicePlannerPage.hidden = true;
  }

  // One expandable row per project in the invoice-due banner. Header shows
  // the day count + amount; expanded body is the Mon–Fri × 2 planner where
  // the user assigns 8h slots from the (tracked + banked) pool.
  function buildInvoiceProjectRow(entry) {
    const row = document.createElement('div');
    row.className = 'invoice-project-row';
    row.classList.add('expanded'); // open by default — this is the planner

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'invoice-project-head';
    head.setAttribute('aria-expanded', 'true');

    const left = document.createElement('div');
    left.className = 'invoice-project-head-left';

    const caret = document.createElement('span');
    caret.className = 'invoice-caret';
    caret.textContent = '▾';
    caret.setAttribute('aria-hidden', 'true');

    const nameBlock = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'invoice-project-name';
    name.textContent = entry.name;
    const meta = document.createElement('div');
    meta.className = 'invoice-project-meta';
    meta.textContent = buildRowMetaText(entry);
    nameBlock.appendChild(name);
    nameBlock.appendChild(meta);

    left.appendChild(caret);
    left.appendChild(nameBlock);

    const amt = document.createElement('div');
    amt.className = 'invoice-project-amount';
    amt.textContent = fmtMoney(entry.amount);

    head.appendChild(left);
    head.appendChild(amt);

    const details = document.createElement('div');
    details.className = 'invoice-project-dates';

    // Pool summary — the headline "you have X hours to play with" line.
    const pool = document.createElement('div');
    pool.className = 'invoice-pool-line';
    pool.textContent = buildPoolLineText(entry);
    details.appendChild(pool);

    // Plain-English banking math (what's billed, what banks forward).
    const bankLine = document.createElement('div');
    bankLine.className = 'invoice-bank-line';
    bankLine.textContent = buildBankLineText(entry);
    details.appendChild(bankLine);

    // Mon–Fri × 2 grid. Each cell is a date the user can toggle as a
    // billable 8h day. Cells lock once the pool can't fit another day.
    details.appendChild(buildWeekdayPicker(entry));

    // Optional per-day tracked detail underneath. Helps the user see which
    // days actually had work logged when picking which to bill.
    if (entry.dates.length > 0) {
      const datesHdr = document.createElement('div');
      datesHdr.className = 'invoice-dates-header';
      datesHdr.textContent = 'Tracked this fortnight';
      details.appendChild(datesHdr);
      for (const d of entry.dates) {
        const item = document.createElement('div');
        item.className = 'invoice-date-item';
        const label = document.createElement('span');
        label.className = 'invoice-date-label';
        label.textContent = formatWeekdayDate(d);
        const hrs = document.createElement('span');
        hrs.className = 'invoice-date-hours';
        hrs.textContent = formatHM(entry.secondsByDate[d] || 0);
        item.appendChild(label);
        item.appendChild(hrs);
        details.appendChild(item);
      }
    }

    head.addEventListener('click', () => {
      const nowOpen = !!details.hidden;
      details.hidden = !nowOpen;
      row.classList.toggle('expanded', nowOpen);
      caret.textContent = nowOpen ? '▾' : '▸';
      head.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
    });

    row.appendChild(head);
    row.appendChild(details);
    return row;
  }

  // Mon–Fri × 2 weeks of buttons. Each cell is one 8h slot the user can
  // toggle on/off. The pool (tracked + banked) caps how many can be on at
  // once — surplus cells render as locked and ignore clicks. Selected
  // cells highlight green so it's obvious what's being billed.
  function buildWeekdayPicker(entry) {
    const wrap = document.createElement('div');
    wrap.className = 'invoice-planner';

    for (let week = 0; week < 2; week++) {
      const wkLabel = document.createElement('div');
      wkLabel.className = 'invoice-planner-week-label';
      wkLabel.textContent = 'Week ' + (week + 1);
      wrap.appendChild(wkLabel);

      const grid = document.createElement('div');
      grid.className = 'invoice-planner-grid';

      const startIdx = week * 5;
      for (let i = 0; i < 5; i++) {
        const dateKey = entry.weekdayKeys[startIdx + i];
        if (!dateKey) continue;
        grid.appendChild(buildDayCell(entry, dateKey));
      }
      wrap.appendChild(grid);
    }

    return wrap;
  }

  function buildDayCell(entry, dateKey) {
    const isSelected = entry.selectedDates.has(dateKey);
    const poolFull   = entry.selectedDates.size >= entry.maxDays;
    const isLocked   = !isSelected && poolFull;

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'invoice-day-cell' +
      (isSelected ? ' selected' : '') +
      (isLocked   ? ' locked'   : '');
    cell.disabled = isLocked;
    cell.setAttribute(
      'aria-pressed',
      isSelected ? 'true' : 'false',
    );

    const [y, m, d] = dateKey.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);

    const dayName = document.createElement('span');
    dayName.className = 'invoice-day-cell-name';
    dayName.textContent = dateObj.toLocaleDateString(undefined, { weekday: 'short' });

    const dayNum = document.createElement('span');
    dayNum.className = 'invoice-day-cell-num';
    dayNum.textContent =
      d + ' ' + dateObj.toLocaleDateString(undefined, { month: 'short' });

    const billed = document.createElement('span');
    billed.className = 'invoice-day-cell-billed';
    billed.textContent = isSelected ? '8h' : '—';

    // Show tracked-on-this-date if any, so the user has context for which
    // days they actually worked.
    const trackedSec = entry.secondsByDate[dateKey] || 0;
    if (trackedSec > 0) {
      const note = document.createElement('span');
      note.className = 'invoice-day-cell-tracked';
      note.textContent = 'tracked ' + formatHM(trackedSec);
      cell.appendChild(dayName);
      cell.appendChild(dayNum);
      cell.appendChild(billed);
      cell.appendChild(note);
    } else {
      cell.appendChild(dayName);
      cell.appendChild(dayNum);
      cell.appendChild(billed);
    }

    cell.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const sel = invoiceSelectedDays[entry.id] || new Set();
      if (sel.has(dateKey)) {
        sel.delete(dateKey);
      } else if (sel.size < entry.maxDays) {
        sel.add(dateKey);
      } else {
        return; // pool full
      }
      invoiceSelectedDays[entry.id] = sel;
      renderInvoice();
    });

    return cell;
  }

  function buildPoolLineText(entry) {
    const tracked = formatHM(entry.trackedSeconds);
    const banked  = entry.bankedIn > 0 ? ' + ' + formatHM(entry.bankedIn) + ' banked' : '';
    const pool    = formatHM(entry.totalSeconds);
    const slots   = ' → up to ' + entry.maxDays +
      (entry.maxDays === 1 ? ' day' : ' days') + ' (' + entry.maxDays * HOURS_PER_DAY + 'h)';
    return tracked + ' tracked' + banked + ' = ' + pool + ' to allocate' + slots;
  }

  function buildRowMetaText(entry) {
    const base = entry.days + ' × 8h day' + (entry.days === 1 ? '' : 's') +
                 ' @ ' + fmtMoney(entry.daily_rate);
    if (entry.bankedIn === 0 && entry.bankedOut === 0) return base;
    const carry = entry.bankedOut > 0
      ? '+' + formatHM(entry.bankedOut) + ' banked forward'
      : 'fully drained';
    return base + ' · ' + carry;
  }

  // Plain-English breakdown of how the bank, the tracked time, and the day
  // count fit together. Reads top-to-bottom so the user can see exactly what
  // rolls in, what gets billed, and what banks forward.
  function buildBankLineText(entry) {
    const tracked = formatHM(entry.trackedSeconds);
    const billedHours = entry.days * HOURS_PER_DAY;
    const billedPart = entry.days === 0
      ? 'no full day to bill yet'
      : 'bill ' + entry.days + ' × 8h = ' + billedHours + 'h';
    const inPart = entry.bankedIn > 0
      ? ' + ' + formatHM(entry.bankedIn) + ' rolled in from bank'
      : '';
    const carryPart = entry.bankedOut > 0
      ? formatHM(entry.bankedOut) + ' banked for next fortnight'
      : 'bank empty for next fortnight';
    return tracked + ' tracked' + inPart + ' → ' + billedPart + ', ' + carryPart;
  }

  // Signed "Hh Mm" — negative values get a leading "-". Used for banked
  // balances which can go negative when a fortnight is rounded up.
  function formatSignedHM(seconds) {
    const sign = seconds < 0 ? '-' : '';
    return sign + formatHM(Math.abs(seconds));
  }

  // "Mon 6 Apr" — weekday-prefixed short date for the invoice breakdown.
  function formatWeekdayDate(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
    });
  }

  async function copyInvoiceLineItems() {
    const text = invoicePlannerBodyEl.dataset.lineItems || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const prev = invoicePlannerCopyBtn.textContent;
      invoicePlannerCopyBtn.textContent = 'Copied!';
      setTimeout(() => { invoicePlannerCopyBtn.textContent = prev; }, 1500);
    } catch (err) {
      // Clipboard API may be blocked (e.g. non-secure context) — fall back to prompt.
      prompt('Copy the invoice line items:', text);
    }
  }

  async function saveInvoice() {
    const through = invoicePlannerBodyEl.dataset.throughDate;
    if (!through) return;
    const todayKey = localDateKey(new Date());
    const isMidPeriod = todayKey <= through;
    const message = isMidPeriod
      ? 'Save and process this invoice now? The current fortnight isn\'t officially ' +
        'over until ' + through + '.\n\n' +
        'Any time you log in the remaining days won\'t roll into the next invoice ' +
        'automatically — track it as usual and use the Edit button on Banked hours ' +
        'to add it to your bank if needed.\n\n' +
        'Continue?'
      : 'Save and process this invoice? The next fortnight will start fresh and ' +
        'any leftover hours will be banked forward as still-chargeable for your ' +
        'next invoice.';
    if (!confirm(message)) return;
    invoicePlannerSaveBtn.disabled = true;
    try {
      let invoiced = [];
      try { invoiced = JSON.parse(invoicePlannerBodyEl.dataset.invoicedPayload || '[]'); }
      catch (_) { invoiced = []; }
      await api('POST', '/api/invoice/mark-sent', { through, invoiced });
      invoiceSelectedDays = {};
      closeInvoicePlanner();
      await loadInvoiceStatus();
    } catch (err) {
      alert('Could not save invoice: ' + err.message);
    } finally {
      invoicePlannerSaveBtn.disabled = false;
    }
  }

  async function submitInvoiceSetup(e) {
    e.preventDefault();
    const anchor = invoiceSetupDate.value;
    if (!anchor) return;
    try {
      await api('POST', '/api/invoice/settings', { anchor });
      await loadInvoiceStatus();
    } catch (err) {
      alert('Could not save: ' + err.message);
    }
  }

  function openInvoiceSettings() {
    if (invoiceAnchor) invoiceSetupDate.value = invoiceAnchor;
    invoiceSetup.hidden = false;
  }

  function dismissInvoiceSetup() {
    invoiceSetup.hidden = true;
  }

  // ── Service worker registration (PWA install + offline shell) ────────────

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.error('[sw] registration failed:', err);
      });
    });

    // The service worker posts a 'timer:resync' message after it handles a
    // notification action (Yes, still working / No, stop timer). Re-pull
    // active-session state so the banner doesn't keep ticking against a
    // session the server has already closed — which was the path to the
    // "your time didn't get logged" bug.
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'timer:resync') {
        loadAll().catch(console.error);
      }
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

  // ── Storage status check ──────────────────────────────────────────────────
  //
  // Fetch /api/status once on load. If the backend reports ephemeral storage,
  // show a loud warning banner so the user knows data will be lost on
  // redeploy and can download a backup immediately.

  async function checkStorage() {
    const warningEl = document.getElementById('storage-warning');
    const bodyEl    = document.getElementById('storage-warning-body');
    const footerEl  = document.getElementById('storage-footer');
    try {
      const s = await api('GET', '/api/status');
      const { persistent, reason, on_railway } = s.storage;
      if (persistent) {
        warningEl.hidden = true;
        if (footerEl) footerEl.textContent = 'Data storage: persistent';
        return;
      }
      const fix = on_railway
        ? ' Attach a Railway volume (Service → Settings → Volumes → New Volume, mount path /data) and redeploy.'
        : '';
      bodyEl.textContent =
        'Storage is ephemeral and will be wiped on the next restart or redeploy — ' +
        reason + '.' + fix +
        ' In the meantime, download a backup so nothing is lost.';
      warningEl.hidden = false;
      if (footerEl) footerEl.textContent = 'Data storage: ⚠ ephemeral';
    } catch (err) {
      console.warn('[status] check failed:', err);
    }
  }

  // ── Event wiring ─────────────────────────────────────────────────────────

  addProjectBtn.addEventListener('click', addProject);
  newProjectInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addProject(); });
  bannerStopBtn.addEventListener('click', () => stopTimer());

  invoicePlanBtn.addEventListener('click', openInvoicePlanner);
  invoicePlannerBackBtn.addEventListener('click', closeInvoicePlanner);
  invoicePlannerCopyBtn.addEventListener('click', copyInvoiceLineItems);
  invoicePlannerSaveBtn.addEventListener('click', saveInvoice);
  invoiceSettingsBtn.addEventListener('click', openInvoiceSettings);
  invoiceSetupForm.addEventListener('submit', submitInvoiceSetup);
  invoiceSetupDismiss.addEventListener('click', dismissInvoiceSetup);
  invoiceRewindBtn.addEventListener('click', rewindInvoice);

  // Close the planner page on Escape.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !invoicePlannerPage.hidden) closeInvoicePlanner();
  });

  // ── Boot ─────────────────────────────────────────────────────────────────

  loadAll().catch(console.error);
  initPush().catch(console.error);
  checkStorage().catch(console.error);
  loadInvoiceStatus().catch(console.error);
})();
