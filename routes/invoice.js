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
// Advance the anchor, update each project's banked-hours balance, and record
// the invoice + its line items for later display in the history section.
//
//   banked_new = banked_prev + tracked_seconds − invoiced_days × 8h
//
// Round down and the leftover tracked time banks positive; round up and the
// balance goes negative (you've pre-billed future work).
const SECONDS_PER_BILLABLE_DAY = 8 * 3600;

router.post('/mark-sent', (req, res) => {
  const through = req.body?.through;
  if (typeof through !== 'string' || !DATE_RE.test(through)) {
    return res.status(400).json({ error: 'through must be YYYY-MM-DD' });
  }
  const invoiced = Array.isArray(req.body?.invoiced) ? req.body.invoiced : [];
  const snapped = snapToSunday(through);
  const prevAnchor = readAnchor();
  const periodStart = prevAnchor
    ? addDaysISO(prevAnchor, 1)   // Monday after prev anchor
    : addDaysISO(snapped, -13);   // fall back to a Mon–Sun fortnight

  const selProject = db.prepare('SELECT id, name, daily_rate, hours_banked_seconds FROM projects WHERE id = ?');
  const setBanked = db.prepare(
    'UPDATE projects SET hours_banked_seconds = ? WHERE id = ?',
  );
  const insInvoice = db.prepare(
    `INSERT INTO invoices (period_start, period_end, total_amount) VALUES (?, ?, ?)`,
  );
  const insLine = db.prepare(
    `INSERT INTO invoice_line_items
      (invoice_id, project_id, project_name, daily_rate,
       tracked_seconds, banked_in_seconds, invoiced_days, banked_out_seconds, amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const apply = db.transaction(() => {
    const lines = [];
    let total = 0;
    for (const item of invoiced) {
      const pid = Number(item?.project_id);
      const tracked = Math.max(0, Math.round(Number(item?.tracked_seconds)) || 0);
      const days = Math.max(0, Math.round(Number(item?.invoiced_days)) || 0);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      const proj = selProject.get(pid);
      if (!proj) continue;
      // Banked is always non-negative — represents still-chargeable hours.
      // If a caller manages to bill more days than the pool covers, clamp
      // the carry-forward at zero rather than leaving a "pre-billed" debt.
      const bankedIn = Math.max(0, proj.hours_banked_seconds);
      const delta = tracked - days * SECONDS_PER_BILLABLE_DAY;
      const bankedOut = Math.max(0, bankedIn + delta);
      const amount = days * proj.daily_rate;
      setBanked.run(bankedOut, pid);
      lines.push({
        project_id: pid,
        project_name: proj.name,
        daily_rate: proj.daily_rate,
        tracked_seconds: tracked,
        banked_in_seconds: bankedIn,
        invoiced_days: days,
        banked_out_seconds: bankedOut,
        amount,
      });
      total += amount;
    }

    // Record the invoice even if it has no line items — the user may mark an
    // empty fortnight as invoiced to advance the anchor.
    const invoiceId = insInvoice.run(periodStart, snapped, total).lastInsertRowid;
    for (const l of lines) {
      insLine.run(
        invoiceId,
        l.project_id,
        l.project_name,
        l.daily_rate,
        l.tracked_seconds,
        l.banked_in_seconds,
        l.invoiced_days,
        l.banked_out_seconds,
        l.amount,
      );
    }

    writeAnchor(snapped);
  });
  apply();

  res.json({ anchor: snapped });
});

function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// GET /api/invoice/history
// Returns past invoices newest-first, each with its line items.
router.get('/history', (req, res) => {
  const invoices = db
    .prepare(
      `SELECT id, period_start, period_end, sent_at, total_amount
       FROM invoices ORDER BY period_end DESC, id DESC`,
    )
    .all();
  const lineStmt = db.prepare(
    `SELECT project_id, project_name, daily_rate,
            tracked_seconds, banked_in_seconds, invoiced_days,
            banked_out_seconds, amount
     FROM invoice_line_items WHERE invoice_id = ? ORDER BY project_name`,
  );
  const out = invoices.map((inv) => ({ ...inv, line_items: lineStmt.all(inv.id) }));
  res.json({ invoices: out });
});

// POST /api/invoice/rewind
// Roll the anchor back 14 days so the previous fortnight's invoice banner
// reappears. If that fortnight is recorded in history, its line items are
// reversed out of the banked-hours ledger and the record is deleted; the
// client can then re-mark it with the right numbers. Projects that had a
// pre-history mark-sent applied to them keep their current banked balance —
// the caller is warned in the confirm dialog.
router.post('/rewind', (req, res) => {
  const anchor = readAnchor();
  if (!anchor) return res.status(400).json({ error: 'no anchor set' });
  const newAnchor = addDaysISO(anchor, -14);

  const selInvoice = db.prepare(
    'SELECT id FROM invoices WHERE period_end = ? ORDER BY id DESC LIMIT 1',
  );
  const selLines = db.prepare(
    'SELECT project_id, banked_in_seconds FROM invoice_line_items WHERE invoice_id = ?',
  );
  const setBanked = db.prepare(
    'UPDATE projects SET hours_banked_seconds = ? WHERE id = ?',
  );
  const delLines = db.prepare('DELETE FROM invoice_line_items WHERE invoice_id = ?');
  const delInvoice = db.prepare('DELETE FROM invoices WHERE id = ?');

  const apply = db.transaction(() => {
    const match = selInvoice.get(anchor);
    let reversed = false;
    if (match) {
      // Each line item recorded the project's bank balance going IN to that
      // invoice. Restoring it directly is exact and side-steps any rounding
      // or clamping drift the forward delta would suffer.
      const lines = selLines.all(match.id);
      for (const l of lines) {
        if (!l.project_id) continue;
        setBanked.run(Math.max(0, l.banked_in_seconds), l.project_id);
      }
      delLines.run(match.id);
      delInvoice.run(match.id);
      reversed = true;
    }
    writeAnchor(newAnchor);
    return reversed;
  });
  const reversed = apply();

  res.json({ anchor: newAnchor, reversedHistory: reversed });
});

// POST /api/invoice/banked  { project_id, hours_banked_seconds }
// Set a project's banked balance directly. Used to reconcile after a rewind
// when the matching invoice was pre-history (no line items to reverse).
// Clamped at zero — banked represents still-chargeable hours, never debt.
router.post('/banked', (req, res) => {
  const pid = Number(req.body?.project_id);
  const value = Number(req.body?.hours_banked_seconds);
  if (!Number.isFinite(pid) || pid <= 0) {
    return res.status(400).json({ error: 'project_id required' });
  }
  if (!Number.isFinite(value)) {
    return res.status(400).json({ error: 'hours_banked_seconds must be a number' });
  }
  const stored = Math.max(0, Math.round(value));
  const result = db
    .prepare('UPDATE projects SET hours_banked_seconds = ? WHERE id = ?')
    .run(stored, pid);
  if (result.changes === 0) return res.status(404).json({ error: 'project not found' });
  res.json({ project_id: pid, hours_banked_seconds: stored });
});

module.exports = router;
