// Database layer: a real SQLite file on disk (./data/azzifa.sqlite), not localStorage.
// Single-user, local-first — no accounts, no network dependency for core journaling.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'azzifa.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    date TEXT PRIMARY KEY,
    mood TEXT NOT NULL,
    prompt TEXT NOT NULL,
    text TEXT NOT NULL,
    notes TEXT,
    day_summary TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
// Older databases created before these columns existed still work — migrate them in if missing.
const cols = db.prepare("PRAGMA table_info(entries)").all().map(c => c.name);
if (!cols.includes('notes')) {
  db.exec('ALTER TABLE entries ADD COLUMN notes TEXT');
}
if (!cols.includes('day_summary')) {
  db.exec('ALTER TABLE entries ADD COLUMN day_summary TEXT');
}

module.exports = db;
