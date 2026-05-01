const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ── Resolve data directory & classify persistence ──────────────────────────
//
// Priority:
//   1. Explicit DB_DIR — caller takes responsibility.
//   2. RAILWAY_VOLUME_MOUNT_PATH — set automatically by Railway when a
//      volume is attached. Always persistent.
//   3. /tmp on Railway with no volume — EPHEMERAL. Container restart wipes it.
//   4. ./data locally — persistent to local disk.

const explicitDir = process.env.DB_DIR;
const volumeDir   = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const onRailway   = !!process.env.RAILWAY_ENVIRONMENT;

let dataDir;
let persistent;
let reason;

if (explicitDir) {
  dataDir = explicitDir;
  // Treat /tmp as ephemeral even if set explicitly — it's wiped on most hosts.
  persistent = !(explicitDir === '/tmp' || explicitDir.startsWith('/tmp/'));
  reason = persistent ? 'DB_DIR override' : 'DB_DIR points at /tmp (ephemeral)';
} else if (volumeDir) {
  dataDir = volumeDir;
  persistent = true;
  reason = 'Railway volume attached';
} else if (onRailway) {
  dataDir = '/tmp';
  persistent = false;
  reason = 'Railway with NO volume attached — data will be lost on every redeploy';
} else {
  dataDir = path.join(__dirname, 'data');
  persistent = true;
  reason = 'local ./data directory';
}

const dbPath = path.join(dataDir, 'db.sqlite');

// Ensure the data directory exists before opening the DB.
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// ── Startup banner ─────────────────────────────────────────────────────────

function logStorageBanner() {
  if (persistent) {
    console.log(`[db] ✓ persistent storage: ${dbPath}  (${reason})`);
    return;
  }
  const line = '═'.repeat(69);
  console.warn(`
╔${line}╗
║  ⚠️  EPHEMERAL STORAGE — DATA WILL BE LOST ON EVERY REDEPLOY         ║
║                                                                     ║
║  ${reason.padEnd(67)}║
║                                                                     ║
║  To fix: in the Railway dashboard                                   ║
║    → Service → Settings → Volumes → New Volume                      ║
║    → Mount path: /data  (any path works, just pick one)             ║
║    → Redeploy                                                       ║
║                                                                     ║
║  Current DB file (ephemeral):                                       ║
║    ${dbPath.padEnd(65)}║
╚${line}╝
`);
}

// ── Open DB ────────────────────────────────────────────────────────────────

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      start_time DATETIME NOT NULL,
      end_time DATETIME,
      duration_seconds INTEGER,
      last_notified_at DATETIME,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY,
      subscription_json TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      total_amount REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id INTEGER PRIMARY KEY,
      invoice_id INTEGER NOT NULL,
      project_id INTEGER,
      project_name TEXT NOT NULL,
      daily_rate REAL NOT NULL,
      tracked_seconds INTEGER NOT NULL DEFAULT 0,
      banked_in_seconds INTEGER NOT NULL DEFAULT 0,
      invoiced_days INTEGER NOT NULL DEFAULT 0,
      banked_out_seconds INTEGER NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(end_time);
    CREATE INDEX IF NOT EXISTS idx_line_items_invoice ON invoice_line_items(invoice_id);
  `);

  // Idempotent migrations — SQLite throws if a column already exists, which we swallow.
  for (const stmt of [
    'ALTER TABLE projects ADD COLUMN daily_rate REAL NOT NULL DEFAULT 650',
    'ALTER TABLE projects ADD COLUMN hours_banked_seconds INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN auto_stopped INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { db.exec(stmt); } catch (_) { /* already exists */ }
  }

  // Fix-up: earlier versions accepted any date for invoice_anchor_date. Snap
  // non-Sundays down to the previous Sunday so fortnight boundaries are
  // always Mon–Sun.
  try {
    const row = db
      .prepare("SELECT value FROM app_settings WHERE key = 'invoice_anchor_date'")
      .get();
    if (row?.value) {
      const d = new Date(row.value + 'T00:00:00Z');
      if (!isNaN(d.getTime()) && d.getUTCDay() !== 0) {
        d.setUTCDate(d.getUTCDate() - d.getUTCDay());
        const snapped = d.toISOString().slice(0, 10);
        db.prepare(
          "UPDATE app_settings SET value = ? WHERE key = 'invoice_anchor_date'",
        ).run(snapped);
        console.log('[db] snapped invoice_anchor_date ' + row.value + ' → ' + snapped);
      }
    }
  } catch (_) { /* table may not exist yet on very old DBs */ }

  // Fix-up: legacy invoices using the old round-up logic could leave a
  // project's hours_banked_seconds negative ("pre-billed"). The current
  // model treats banked exclusively as still-chargeable hours, so flip any
  // negatives to their absolute value. Idempotent — once non-negative, the
  // WHERE clause matches nothing.
  try {
    const flipped = db
      .prepare('UPDATE projects SET hours_banked_seconds = -hours_banked_seconds WHERE hours_banked_seconds < 0')
      .run();
    if (flipped.changes > 0) {
      console.log('[db] flipped ' + flipped.changes + ' negative banked balance(s) to positive');
    }
  } catch (_) { /* projects table may not exist yet on very old DBs */ }

  logStorageBanner();
}

function getStorageInfo() {
  return { dataDir, dbPath, persistent, reason, onRailway };
}

module.exports = { db, initDB, getStorageInfo };
