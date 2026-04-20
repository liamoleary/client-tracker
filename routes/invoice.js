const express = require('express');
const { db } = require('../db');

const router = express.Router();

const ANCHOR_KEY = 'invoice_anchor_date';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Anchors represent "the Sunday through which invoices have been sent". Users
// often enter the invoice issue date (a Tue/Wed/whatever) — silently snap
// down to the most recent Sunday on or before the entered date so fortnight
// boundaries always land on Mon–Sun.
function snapToSunday(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const day = d.getUTCDay(); // 0 = Sunday
  if (day !== 0) d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

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
// Returns current anchor + raw sessions since anchor + per-project banked
// hours. The client computes the fortnight boundaries and per-project day
// counts in its local tz so the billing days line up with what the user sees
// in the rest of the UI.
router.get('/status', (req, res) => {
  const anchor = readAnchor();
  const projects = db
    .prepare('SELECT id, name, daily_rate, hours_banked_seconds FROM projects')
    .all();
  res.json({ anchor, sessions: sessionsSinceAnchor(anchor), projects });
});

// POST /api/invoice/settings  { anchor: "YYYY-MM-DD" | null }
// Set the anchor. Any weekday works — we snap to the previous Sunday so the
// fortnight always aligns to Mon–Sun. Pass null to clear.
router.post('/settings', (req, res) => {
  const raw = req.body?.anchor;
  if (raw === null) {
    writeAnchor(null);
    return res.json({ anchor: null });
  }
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) {
    return res.status(400).json({ error: 'anchor must be YYYY-MM-DD or null' });
  }
  const d = new Date(raw + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    return res.status(400).json({ error: 'invalid date' });
  }
  const snapped = snapToSunday(raw);
  writeAnchor(snapped);
  res.json({ anchor: snapped });
});

// POST /api/invoice/mark-sent
//   {
//     through: "YYYY-MM-DD",
//     invoiced: [{ project_id, tracked_seconds, invoiced_days }]
//   }
// Advance the anchor and update each project's banked-hours balance:
//   banked_new = banked_prev + tracked_seconds − invoiced_days × 8h
// So if you round down, the leftover tracked time banks positive; if you
// round up, the balance goes negative (you've pre-billed future work).
const SECONDS_PER_BILLABLE_DAY = 8 * 3600;

router.post('/mark-sent', (req, res) => {
  const through = req.body?.through;
  if (typeof through !== 'string' || !DATE_RE.test(through)) {
    return res.status(400).json({ error: 'through must be YYYY-MM-DD' });
  }
  const invoiced = Array.isArray(req.body?.invoiced) ? req.body.invoiced : [];

  const updateBanked = db.prepare(
    'UPDATE projects SET hours_banked_seconds = hours_banked_seconds + ? WHERE id = ?',
  );
  const snapped = snapToSunday(through);

  const apply = db.transaction(() => {
    for (const item of invoiced) {
      const pid = Number(item?.project_id);
      const tracked = Number(item?.tracked_seconds);
      const days = Number(item?.invoiced_days);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (!Number.isFinite(tracked) || !Number.isFinite(days)) continue;
      const delta = Math.round(tracked - days * SECONDS_PER_BILLABLE_DAY);
      updateBanked.run(delta, pid);
    }
    writeAnchor(snapped);
  });
  apply();

  res.json({ anchor: snapped });
});

module.exports = router;
