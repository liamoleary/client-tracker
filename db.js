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
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(end_time);
  `);

  // Idempotent migrations — SQLite throws if a column already exists, which we swallow.
  for (const stmt of [
    'ALTER TABLE projects ADD COLUMN daily_rate REAL NOT NULL DEFAULT 650',
    'ALTER TABLE sessions ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { db.exec(stmt); } catch (_) { /* already exists */ }
  }

  logStorageBanner();
}

function getStorageInfo() {
  return { dataDir, dbPath, persistent, reason, onRailway };
}

module.exports = { db, initDB, getStorageInfo };
