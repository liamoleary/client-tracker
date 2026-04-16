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

// POST /api/timer/stop
// Optional body: { duration_seconds } — if provided, overrides the calculated duration.
router.post('/stop', (req, res) => {
  const active = getActiveSession();
  if (!active) {
    return res.status(400).json({ error: 'No timer is running' });
  }

  const startTime = new Date(active.start_time);
  let duration;
  let endTime;

  const rawDuration = req.body?.duration_seconds;
  if (rawDuration !== undefined) {
    duration = Math.round(Number(rawDuration));
    if (!Number.isFinite(duration) || duration < 0) {
      return res.status(400).json({ error: 'invalid duration_seconds' });
    }
    endTime = new Date(startTime.getTime() + duration * 1000);
  } else {
    endTime = new Date();
    duration = Math.max(
      0,
      Math.round((endTime.getTime() - startTime.getTime()) / 1000),
    );
  }

  db.prepare(
    'UPDATE sessions SET end_time = ?, duration_seconds = ? WHERE id = ?',
  ).run(endTime.toISOString(), duration, active.id);

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
    .get(active.id);

  res.json(session);
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
