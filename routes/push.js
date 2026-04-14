const express = require('express');
const webpush = require('web-push');
const { db } = require('../db');

const router = express.Router();

let configured = false;

function configureWebPush() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_EMAIL) {
    console.warn(
      '[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_EMAIL not all set — push notifications disabled.',
    );
    return false;
  }
  webpush.setVapidDetails(
    `mailto:${VAPID_EMAIL}`,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY,
  );
  configured = true;
  return true;
}

function isConfigured() {
  return configured;
}

// GET /api/push/vapid-public-key
router.get('/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

// POST /api/push/subscribe
// Body: a Web Push subscription object ({ endpoint, keys: { p256dh, auth } })
router.post('/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || typeof sub !== 'object' || !sub.endpoint) {
    return res.status(400).json({ error: 'invalid subscription' });
  }

  // De-dupe by endpoint: if we already have this subscription, update it;
  // otherwise insert a new row.
  const existing = db
    .prepare(
      `SELECT id FROM push_subscriptions
       WHERE json_extract(subscription_json, '$.endpoint') = ?`,
    )
    .get(sub.endpoint);

  const json = JSON.stringify(sub);
  if (existing) {
    db.prepare(
      'UPDATE push_subscriptions SET subscription_json = ? WHERE id = ?',
    ).run(json, existing.id);
  } else {
    db.prepare(
      'INSERT INTO push_subscriptions (subscription_json) VALUES (?)',
    ).run(json);
  }

  res.json({ saved: true });
});

// Send a push to every stored subscription. Drops subscriptions that the
// push service reports as gone (404/410).
async function sendPushToAll(payload) {
  if (!configured) {
    console.warn('[push] sendPushToAll called but web-push not configured');
    return { sent: 0, failed: 0, removed: 0 };
  }

  const rows = db
    .prepare('SELECT id, subscription_json FROM push_subscriptions')
    .all();

  let sent = 0;
  let failed = 0;
  let removed = 0;
  const body = JSON.stringify(payload);

  await Promise.all(
    rows.map(async (row) => {
      let sub;
      try {
        sub = JSON.parse(row.subscription_json);
      } catch {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
        removed += 1;
        return;
      }
      try {
        await webpush.sendNotification(sub, body);
        sent += 1;
      } catch (err) {
        failed += 1;
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
          removed += 1;
        } else {
          console.error('[push] send failed:', err && err.message);
        }
      }
    }),
  );

  return { sent, failed, removed };
}

module.exports = { router, configureWebPush, sendPushToAll, isConfigured };
