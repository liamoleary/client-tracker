const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Prefer an explicitly mounted Railway volume, then fall back to /tmp on
// Railway (ephemeral but lets the app boot), then to ./data locally.
const dataDir =
  process.env.DB_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  (process.env.RAILWAY_ENVIRONMENT ? '/tmp' : path.join(__dirname, 'data'));
const dbPath = path.join(dataDir, 'db.sqlite');

// Ensure the data directory exists before opening the DB.
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

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

  // Helpful indexes for the queries we'll run later.
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
}

module.exports = { db, initDB };
