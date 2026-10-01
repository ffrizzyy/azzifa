// Database layer: a real SQLite file on disk (./data/azzifa.sqlite), not localStorage.
// Several people can share one server: every journal row belongs to a user, and nothing but
// "did they write today" is ever shared between them (see circles, below).
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// DATA_DIR lets a deploy point this at its persistent disk (and lets tests use a throwaway one).
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'azzifa.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  -- A circle is a group of people keeping a streak together.
  CREATE TABLE IF NOT EXISTS circles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS circle_members (
    circle_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at INTEGER NOT NULL,
    joined_day TEXT,
    PRIMARY KEY (circle_id, user_id)
  );
  -- Pictures attached to notes. Kept in the database itself so one file is still the whole
  -- journal: backing up or moving azzifa.sqlite takes the pictures with it.
  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    attached INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS photos_by_user ON photos (user_id, attached);
`);

const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// joined_day is the member's own local date when they joined; rows from before it existed
// fall back to the UTC date of joined_at (see circles.js).
if (!columnsOf('circle_members').includes('joined_day')) {
  db.exec('ALTER TABLE circle_members ADD COLUMN joined_day TEXT');
}

// entries and settings are keyed per user. Databases from the single-user version have no
// user_id column: rebuild those tables with their rows parked on user_id 0, which the first
// account to register then inherits (see /api/auth/register).
const TABLES = {
  entries: {
    columns: ['date', 'mood', 'prompt', 'text', 'notes', 'day_summary', 'updated_at'],
    create: `CREATE TABLE entries (
      user_id INTEGER NOT NULL DEFAULT 0,
      date TEXT NOT NULL,
      mood TEXT NOT NULL,
      prompt TEXT NOT NULL,
      text TEXT NOT NULL,
      notes TEXT,
      day_summary TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, date)
    )`,
  },
  settings: {
    columns: ['key', 'value'],
    create: `CREATE TABLE settings (
      user_id INTEGER NOT NULL DEFAULT 0,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (user_id, key)
    )`,
  },
};
Object.entries(TABLES).forEach(([table, def]) => {
  const existing = columnsOf(table);
  if (existing.length === 0) { db.exec(def.create); return; }
  if (existing.includes('user_id')) return;
  // Older single-user tables may also predate notes/day_summary — copy only what they have.
  const shared = def.columns.filter((c) => existing.includes(c)).join(', ');
  db.transaction(() => {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_single_user`);
    db.exec(def.create);
    db.exec(`INSERT INTO ${table} (user_id, ${shared}) SELECT 0, ${shared} FROM ${table}_single_user`);
    db.exec(`DROP TABLE ${table}_single_user`);
  })();
});

module.exports = db;
