const express = require('express');
const { db } = require('../db');

const router = express.Router();

// GET /api/projects
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT
         p.id,
         p.name,
         p.daily_rate,
         p.created_at,
         COALESCE(SUM(s.duration_seconds), 0) AS total_seconds
       FROM projects p
       LEFT JOIN sessions s
         ON s.project_id = p.id
         AND s.end_time IS NOT NULL
       GROUP BY p.id
       ORDER BY p.created_at ASC, p.id ASC`,
    )
    .all();
  res.json(rows);
});

// POST /api/projects  { name, daily_rate? }
router.post('/', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });

  const dailyRate = req.body?.daily_rate !== undefined
    ? Number(req.body.daily_rate)
    : 650;
  if (!isFinite(dailyRate) || dailyRate < 0) {
    return res.status(400).json({ error: 'daily_rate must be a non-negative number' });
  }

  const info = db
    .prepare('INSERT INTO projects (name, daily_rate) VALUES (?, ?)')
    .run(name, dailyRate);

  const project = db
    .prepare(
      `SELECT id, name, daily_rate, created_at, 0 AS total_seconds
       FROM projects WHERE id = ?`,
    )
    .get(info.lastInsertRowid);

  res.status(201).json(project);
});

// PATCH /api/projects/:id  { daily_rate }
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'project not found' });

  const dailyRate = Number(req.body?.daily_rate);
  if (!isFinite(dailyRate) || dailyRate < 0) {
    return res.status(400).json({ error: 'daily_rate must be a non-negative number' });
  }

  db.prepare('UPDATE projects SET daily_rate = ? WHERE id = ?').run(dailyRate, id);

  const updated = db
    .prepare(
      `SELECT
         p.id, p.name, p.daily_rate, p.created_at,
         COALESCE(SUM(s.duration_seconds), 0) AS total_seconds
       FROM projects p
       LEFT JOIN sessions s ON s.project_id = p.id AND s.end_time IS NOT NULL
       WHERE p.id = ?
       GROUP BY p.id`,
    )
    .get(id);

  res.json(updated);
});

module.exports = router;
