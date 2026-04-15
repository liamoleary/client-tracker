const express = require('express');
const { db } = require('../db');

const router = express.Router();

// GET /api/sessions/:project_id
// Returns all completed sessions for the project, newest first.
router.get('/:project_id', (req, res) => {
  const projectId = Number(req.params.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'invalid project_id' });
  }

  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });

  const sessions = db
    .prepare(
      `SELECT id, project_id, start_time, end_time, duration_seconds, is_manual, last_notified_at
       FROM sessions
       WHERE project_id = ? AND end_time IS NOT NULL
       ORDER BY start_time DESC, id DESC`,
    )
    .all(projectId);

  res.json(sessions);
});

// POST /api/sessions
// Creates a manual session entry.
// Body: { project_id, start_time (ISO string), hours, minutes }
router.post('/', (req, res) => {
  const projectId = Number(req.body?.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'project_id is required' });
  }

  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });

  const startTimeRaw = req.body?.start_time;
  if (!startTimeRaw) return res.status(400).json({ error: 'start_time is required' });

  const startDate = new Date(startTimeRaw);
  if (isNaN(startDate.getTime())) return res.status(400).json({ error: 'invalid start_time' });

  const hours = Math.max(0, Math.floor(Number(req.body?.hours) || 0));
  const minutes = Math.max(0, Math.floor(Number(req.body?.minutes) || 0));
  const durationSeconds = hours * 3600 + minutes * 60;
  if (durationSeconds <= 0) {
    return res.status(400).json({ error: 'duration must be greater than zero' });
  }

  const endDate = new Date(startDate.getTime() + durationSeconds * 1000);

  const info = db
    .prepare(
      `INSERT INTO sessions (project_id, start_time, end_time, duration_seconds, is_manual)
       VALUES (?, ?, ?, ?, 1)`,
    )
    .run(projectId, startDate.toISOString(), endDate.toISOString(), durationSeconds);

  const session = db
    .prepare(
      `SELECT id, project_id, start_time, end_time, duration_seconds, is_manual, last_notified_at
       FROM sessions WHERE id = ?`,
    )
    .get(info.lastInsertRowid);

  res.status(201).json(session);
});

// DELETE /api/sessions/:id
// Removes a completed session. Active sessions (no end_time) cannot be deleted here.
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const session = db
    .prepare('SELECT id, end_time FROM sessions WHERE id = ?')
    .get(id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!session.end_time) {
    return res.status(400).json({ error: 'cannot delete an active session — stop the timer first' });
  }

  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  res.status(204).end();
});

module.exports = router;
