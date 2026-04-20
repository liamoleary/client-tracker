const express = require('express');
const { db } = require('../db');

const router = express.Router();

const ANCHOR_KEY = 'invoice_anchor_date';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readAnchor() {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(ANCHOR_KEY);
  return row?.value || null;
}

function writeAnchor(value) {
  if (value === null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(ANCHOR_KEY);
    return;
  }
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(ANCHOR_KEY, value);
}

// Returns completed sessions whose start_time is strictly after the given
// YYYY-MM-DD anchor (interpreted as the local calendar date — we use
// `anchor + 'T00:00:00.000Z'` as a loose lower bound, then let the client
// filter precisely in its local timezone). We fetch a generous window so the
// client can handle tz offsets up to ±14 hours.
function sessionsSinceAnchor(anchor) {
  if (!anchor) return [];
  const lower = new Date(anchor + 'T00:00:00.000Z');
  lower.setUTCDate(lower.getUTCDate() - 1); // pad a day for tz
  return db
    .prepare(
      `SELECT s.id, s.project_id, s.start_time, s.duration_seconds,
              p.name AS project_name, p.daily_rate
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.end_time IS NOT NULL
         AND s.start_time >= ?
       ORDER BY s.start_time ASC, s.id ASC`,
    )
    .all(lower.toISOString());
}

// GET /api/invoice/status
// Returns current anchor + raw sessions since anchor. The client computes
// the fortnight boundaries and per-project day counts in its local tz so the
// billing days line up with what the user sees in the rest of the UI.
router.get('/status', (req, res) => {
  const anchor = readAnchor();
  res.json({ anchor, sessions: sessionsSinceAnchor(anchor) });
});

// POST /api/invoice/settings  { anchor: "YYYY-MM-DD" | null }
// Set the anchor: the Sunday through which invoices have been sent. Pass
// null to clear.
router.post('/settings', (req, res) => {
  const raw = req.body?.anchor;
  if (raw === null) {
    writeAnchor(null);
    return res.json({ anchor: null });
  }
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) {
    return res.status(400).json({ error: 'anchor must be YYYY-MM-DD or null' });
  }
  // Basic sanity: must be a real date.
  const d = new Date(raw + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    return res.status(400).json({ error: 'invalid date' });
  }
  writeAnchor(raw);
  res.json({ anchor: raw });
});

// POST /api/invoice/mark-sent  { through: "YYYY-MM-DD" }
// Advance the anchor after sending an invoice. `through` is the last day
// covered by the invoice (a Sunday). Idempotent — later writes just move the
// anchor forward.
router.post('/mark-sent', (req, res) => {
  const through = req.body?.through;
  if (typeof through !== 'string' || !DATE_RE.test(through)) {
    return res.status(400).json({ error: 'through must be YYYY-MM-DD' });
  }
  writeAnchor(through);
  res.json({ anchor: through });
});

module.exports = router;
