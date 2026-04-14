const cron = require('node-cron');
const { db } = require('../db');
const { sendPushToAll, isConfigured } = require('../routes/push');

const HOUR_MS = 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * HOUR_MS;

// Find the currently active session (end_time IS NULL), joined with project name.
function getActiveSession() {
  return db
    .prepare(
      `
      SELECT
        s.id,
        s.project_id,
        s.start_time,
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

async function tick(now = new Date()) {
  const active = getActiveSession();
  if (!active) return;

  const lastNotifiedMs = active.last_notified_at
    ? new Date(active.last_notified_at).getTime()
    : null;
  const startMs = new Date(active.start_time).getTime();
  const referenceMs = lastNotifiedMs ?? startMs;
  const elapsedMs = now.getTime() - referenceMs;

  // (b) AUTO-STOP CHECK
  // Only auto-stop if we've actually notified (otherwise the user has no
  // chance to confirm) and more than 2h have passed without a confirm.
  if (lastNotifiedMs !== null && elapsedMs >= TWO_HOURS_MS) {
    const endTime = new Date(lastNotifiedMs + TWO_HOURS_MS);
    const durationSec = Math.max(
      0,
      Math.round((endTime.getTime() - startMs) / 1000),
    );
    db.prepare(
      'UPDATE sessions SET end_time = ?, duration_seconds = ? WHERE id = ?',
    ).run(endTime.toISOString(), durationSec, active.id);
    console.log(
      `[monitor] auto-stopped session ${active.id} (project "${active.project_name}") after 2h silence; duration=${durationSec}s`,
    );
    return;
  }

  // (a) HOURLY NOTIFICATION CHECK
  if (elapsedMs >= HOUR_MS) {
    const payload = {
      title: 'Still working?',
      body: `Still working on ${active.project_name}? Tap to confirm or stop.`,
      data: { action: 'check-in', session_id: active.id },
    };
    try {
      const result = await sendPushToAll(payload);
      console.log(
        `[monitor] check-in sent for session ${active.id}: ${JSON.stringify(result)}`,
      );
    } catch (err) {
      console.error('[monitor] failed to send check-in:', err && err.message);
    }
    db.prepare('UPDATE sessions SET last_notified_at = ? WHERE id = ?').run(
      now.toISOString(),
      active.id,
    );
  }
}

function start() {
  // Every 5 minutes.
  cron.schedule('*/5 * * * *', () => {
    tick().catch((err) =>
      console.error('[monitor] tick error:', err && err.message),
    );
  });
  console.log(
    `[monitor] cron scheduled (every 5 min); web-push configured=${isConfigured()}`,
  );
}

module.exports = { start, tick };
