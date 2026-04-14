const express = require('express');
const { db } = require('../db');

const router = express.Router();

// GET /api/projects
// Returns all projects with a computed total_seconds (sum of duration_seconds
// across completed sessions for that project).
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `
      SELECT
        p.id,
        p.name,
        p.created_at,
        COALESCE(SUM(s.duration_seconds), 0) AS total_seconds
      FROM projects p
      LEFT JOIN sessions s
        ON s.project_id = p.id
        AND s.end_time IS NOT NULL
      GROUP BY p.id
      ORDER BY p.created_at ASC, p.id ASC
      `,
    )
    .all();

  res.json(rows);
});

// POST /api/projects
// Body: { name }
router.post('/', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const info = db
    .prepare('INSERT INTO projects (name) VALUES (?)')
    .run(name);

  const project = db
    .prepare(
      `
      SELECT
        p.id,
        p.name,
        p.created_at,
        0 AS total_seconds
      FROM projects p
      WHERE p.id = ?
      `,
    )
    .get(info.lastInsertRowid);

  res.status(201).json(project);
});

module.exports = router;
