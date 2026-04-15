const express = require('express');
const { db, getStorageInfo } = require('../db');

const router = express.Router();

// GET /api/status
// Reports where data is stored and whether it survives redeploys.
// Consumed by the frontend to show a warning banner when needed.
router.get('/status', (req, res) => {
  const info = getStorageInfo();
  const projectCount = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  const sessionCount = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  res.json({
    storage: {
      persistent: info.persistent,
      reason: info.reason,
      on_railway: info.onRailway,
      path: info.dbPath,
    },
    counts: { projects: projectCount, sessions: sessionCount },
  });
});

// GET /api/backup
// Downloads a JSON snapshot of all projects, sessions and push subscriptions.
// Safe to hit any time — it's a read-only dump.
router.get('/backup', (req, res) => {
  const projects = db
    .prepare('SELECT id, name, daily_rate, created_at FROM projects ORDER BY id')
    .all();
  const sessions = db
    .prepare(
      `SELECT id, project_id, start_time, end_time, duration_seconds,
              is_manual, last_notified_at
         FROM sessions
         ORDER BY id`,
    )
    .all();
  const pushSubscriptions = db
    .prepare('SELECT id, subscription_json, created_at FROM push_subscriptions ORDER BY id')
    .all();

  const payload = {
    version: 1,
    exported_at: new Date().toISOString(),
    projects,
    sessions,
    push_subscriptions: pushSubscriptions,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="client-tracker-backup-${stamp}.json"`,
  );
  res.send(JSON.stringify(payload, null, 2));
});

// POST /api/restore
// Wipes the projects/sessions tables and replaces them with the provided
// backup. Requires `confirm: "REPLACE"` in the body to avoid accidents.
// Note: push subscriptions are not imported — subscribe again after restoring.
router.post('/restore', (req, res) => {
  const body = req.body || {};

  if (body.confirm !== 'REPLACE') {
    return res.status(400).json({
      error: 'confirm must equal "REPLACE" — this will wipe existing data',
    });
  }

  const projects = Array.isArray(body.projects) ? body.projects : null;
  const sessions = Array.isArray(body.sessions) ? body.sessions : null;
  if (!projects || !sessions) {
    return res.status(400).json({ error: 'projects[] and sessions[] are required' });
  }

  // Validate shape before we delete anything.
  for (const p of projects) {
    if (!Number.isInteger(p.id) || typeof p.name !== 'string') {
      return res.status(400).json({ error: 'invalid project row' });
    }
  }
  for (const s of sessions) {
    if (!Number.isInteger(s.id) || !Number.isInteger(s.project_id) || !s.start_time) {
      return res.status(400).json({ error: 'invalid session row' });
    }
  }

  const insProject = db.prepare(
    `INSERT INTO projects (id, name, daily_rate, created_at)
     VALUES (@id, @name, @daily_rate, @created_at)`,
  );
  const insSession = db.prepare(
    `INSERT INTO sessions (
       id, project_id, start_time, end_time, duration_seconds,
       is_manual, last_notified_at
     ) VALUES (
       @id, @project_id, @start_time, @end_time, @duration_seconds,
       @is_manual, @last_notified_at
     )`,
  );

  const tx = db.transaction(() => {
    // Disable foreign keys briefly so we can truncate freely.
    db.pragma('foreign_keys = OFF');
    db.exec('DELETE FROM sessions; DELETE FROM projects;');
    for (const p of projects) {
      insProject.run({
        id: p.id,
        name: p.name,
        daily_rate: Number(p.daily_rate) || 650,
        created_at: p.created_at || new Date().toISOString(),
      });
    }
    for (const s of sessions) {
      insSession.run({
        id: s.id,
        project_id: s.project_id,
        start_time: s.start_time,
        end_time: s.end_time || null,
        duration_seconds:
          s.duration_seconds !== undefined && s.duration_seconds !== null
            ? Number(s.duration_seconds)
            : null,
        is_manual: s.is_manual ? 1 : 0,
        last_notified_at: s.last_notified_at || null,
      });
    }
    db.pragma('foreign_keys = ON');
  });

  try {
    tx();
  } catch (err) {
    db.pragma('foreign_keys = ON');
    return res.status(500).json({ error: 'restore failed: ' + err.message });
  }

  res.json({ restored: true, projects: projects.length, sessions: sessions.length });
});

module.exports = router;
