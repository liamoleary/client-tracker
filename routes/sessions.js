const express = require('express');
const { db } = require('../db');

const router = express.Router();

// GET /api/sessions/:project_id
// Returns all completed sessions for the given project (end_time IS NOT NULL),
// newest first. Returns 404 if the project doesn't exist.
router.get('/:project_id', (req, res) => {
  const projectId = Number(req.params.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'invalid project_id' });
  }

  const project = db
    .prepare('SELECT id, name FROM projects WHERE id = ?')
    .get(projectId);
  if (!project) {
    return res.status(404).json({ error: 'project not found' });
  }

  const sessions = db
    .prepare(
      `
      SELECT
        id,
        project_id,
        start_time,
        end_time,
        duration_seconds,
        last_notified_at
      FROM sessions
      WHERE project_id = ? AND end_time IS NOT NULL
      ORDER BY start_time DESC, id DESC
      `,
    )
    .all(projectId);

  res.json(sessions);
});

module.exports = router;
