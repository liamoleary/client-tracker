const express = require('express');
const { db } = require('../db');

const router = express.Router();

// Return the active session (end_time IS NULL), if any.
function getActiveSession() {
  return db
    .prepare(
      `
      SELECT
        s.id,
        s.project_id,
        s.start_time,
        s.end_time,
        s.duration_seconds,
        s.last_notified_at,
        p.name AS project_name
      FROM sessions s
      JOIN projects p ON p.id = s.project_id
      WHERE s.end_time IS NULL
      ORDER BY s.id DESC
      LIMIT 1
      `,
    )
    .get();
}

// GET /api/timer/active
router.get('/active', (req, res) => {
  const active = getActiveSession();
  res.json(active || null);
});

// POST /api/timer/start  { project_id }
router.post('/start', (req, res) => {
  const projectId = Number(req.body?.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'project_id is required' });
  }

  const project = db
    .prepare('SELECT id, name FROM projects WHERE id = ?')
    .get(projectId);
  if (!project) {
    return res.status(404).json({ error: 'project not found' });
  }

  if (getActiveSession()) {
    return res.status(400).json({ error: 'A timer is already running' });
  }

  const now = new Date().toISOString();
  const info = db
    .prepare(
      'INSERT INTO sessions (project_id, start_time, end_time) VALUES (?, ?, NULL)',
    )
    .run(projectId, now);

  const session = db
    .prepare(
      `
      SELECT
        s.id,
        s.project_id,
        s.start_time,
        s.end_time,
        s.duration_seconds,
        s.last_notified_at,
        p.name AS project_name
      FROM sessions s
      JOIN projects p ON p.id = s.project_id
      WHERE s.id = ?
      `,
    )
    .get(info.lastInsertRowid);

  res.status(201).json(session);
});

// Window during which a stop request can still amend a recently server-closed
// session. Longer than the 2h auto-stop grace so a user who left the app open
// overnight still gets their time applied.
const AUTO_STOP_AMEND_WINDOW_MS = 12 * 60 * 60 * 1000;

// Most recent session closed by the server (auto_stopped=1) — either by the
// monitor's 2h idle auto-stop, or by a "No, stop timer" tap on the check-in
// notification. Used so a later UI stop whose banner was still ticking can
// overwrite the server's conservative duration rather than silently losing
// the work.
function getAmendableAutoStopped() {
  return db
    .prepare(
      `
      SELECT
        s.id,
        s.project_id,
        s.start_time,
        s.end_time,
        s.duration_seconds,
        s.last_notified_at,
        p.name AS project_name
      FROM sessions s
      JOIN projects p ON p.id = s.project_id
      WHERE s.auto_stopped = 1
      ORDER BY s.end_time DESC
      LIMIT 1
      `,
    )
    .get();
}

function sessionById(id) {
  return db
    .prepare(
      `
      SELECT
        s.id,
        s.project_id,
        s.start_time,
        s.end_time,
        s.duration_seconds,
        s.last_notified_at,
        p.name AS project_name
      FROM sessions s
      JOIN projects p ON p.id = s.project_id
      WHERE s.id = ?
      `,
    )
    .get(id);
}

// POST /api/timer/stop
// Optional body: { duration_seconds } — if provided, overrides the calculated duration.
router.post('/stop', (req, res) => {
  const rawDuration = req.body?.duration_seconds;
  const hasDuration = rawDuration !== undefined;
  let duration;
  if (hasDuration) {
    duration = Math.round(Number(rawDuration));
    if (!Number.isFinite(duration) || duration < 0) {
      return res.status(400).json({ error: 'invalid duration_seconds' });
    }
  }

  const active = getActiveSession();
  if (!active) {
    // No live timer — but if the server closed a session recently (monitor
    // auto-stop, or "No, stop timer" tap on a notification) and the client
    // was still ticking against it, let this stop amend that session's
    // duration rather than reject the user's intent and silently lose time.
    if (hasDuration) {
      const recent = getAmendableAutoStopped();
      if (recent) {
        const endedMs = new Date(recent.end_time).getTime();
        if (Date.now() - endedMs <= AUTO_STOP_AMEND_WINDOW_MS) {
          const startMs = new Date(recent.start_time).getTime();
          const newEnd = new Date(startMs + duration * 1000);
          db.prepare(
            'UPDATE sessions SET end_time = ?, duration_seconds = ?, auto_stopped = 0 WHERE id = ?',
          ).run(newEnd.toISOString(), duration, recent.id);
          return res.json(sessionById(recent.id));
        }
      }
    }
    return res.status(400).json({ error: 'No timer is running' });
  }

  const startTime = new Date(active.start_time);
  let endTime;
  if (hasDuration) {
    endTime = new Date(startTime.getTime() + duration * 1000);
  } else {
    endTime = new Date();
    duration = Math.max(
      0,
      Math.round((endTime.getTime() - startTime.getTime()) / 1000),
    );
  }

  // A stop request without a duration can only come from the service worker's
  // "No, stop timer" notification action — the UI always sends duration_seconds.
  // Flag it as auto_stopped so that if the user was actually still working (and
  // a later UI stop arrives with the real duration), the amend path can recover
  // the missing time instead of returning "No timer is running".
  const autoStopped = hasDuration ? 0 : 1;
  db.prepare(
    'UPDATE sessions SET end_time = ?, duration_seconds = ?, auto_stopped = ? WHERE id = ?',
  ).run(endTime.toISOString(), duration, autoStopped, active.id);

  res.json(sessionById(active.id));
});

// POST /api/timer/confirm
router.post('/confirm', (req, res) => {
  const active = getActiveSession();
  if (!active) {
    return res.status(400).json({ error: 'No timer is running' });
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE sessions SET last_notified_at = ? WHERE id = ?').run(
    now,
    active.id,
  );

  res.json({ confirmed: true });
});

module.exports = { router, getActiveSession };
