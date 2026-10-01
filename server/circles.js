// Circles: two or more people keeping a streak together. The only things a circle ever reveals
// about a member are their display name and whether they have written today — never mood or text.
const crypto = require('crypto');
const express = require('express');
const db = require('./db');

const MAX_MEMBERS = 20;
const MAX_CIRCLES_PER_USER = 10;
const STREAK_LOOKBACK_DAYS = 730;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L — codes get read aloud and retyped

// Same day boundary as the rest of the app (UTC), so everyone in a circle shares one "today".
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const newCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

/**
 * The circle as one member sees it. A day counts toward the streak when every member who had
 * joined by that day wrote on it, and at least two had joined. Today not being complete yet
 * does not break the streak — it only breaks once a full day has been missed.
 */
function circleView(circle, viewerId) {
  const members = db.prepare(`
    SELECT u.id, u.name, m.joined_at FROM circle_members m JOIN users u ON u.id = m.user_id
    WHERE m.circle_id = ? ORDER BY m.joined_at ASC
  `).all(circle.id);
  const today = isoDay(Date.now());
  const since = isoDay(Date.now() - STREAK_LOOKBACK_DAYS * 86400000);
  const ids = members.map((m) => m.id);
  const rows = db.prepare(`SELECT user_id, date FROM entries WHERE user_id IN (${ids.map(() => '?').join(',')}) AND date >= ?`).all(...ids, since);
  const wrote = new Set(rows.map((r) => `${r.user_id}|${r.date}`));
  const joined = members.map((m) => ({ id: m.id, day: isoDay(m.joined_at) }));
  const complete = (date) => {
    const due = joined.filter((j) => j.day <= date);
    return due.length >= 2 && due.every((j) => wrote.has(`${j.id}|${date}`));
  };

  const todayComplete = complete(today);
  const cursor = new Date(`${today}T00:00:00Z`);
  if (!todayComplete) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let streak = 0;
  while (streak < STREAK_LOOKBACK_DAYS && complete(isoDay(cursor))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return {
    id: circle.id,
    name: circle.name,
    code: circle.code,
    streak,
    todayComplete,
    members: members.map((m) => ({ name: m.name, me: m.id === viewerId, wroteToday: wrote.has(`${m.id}|${today}`) })),
  };
}

const circlesOf = (userId) => db.prepare(`
  SELECT c.* FROM circles c JOIN circle_members m ON m.circle_id = c.id
  WHERE m.user_id = ? ORDER BY m.joined_at ASC
`).all(userId);
const listFor = (userId) => circlesOf(userId).map((c) => circleView(c, userId));

const router = express.Router();

router.get('/', (req, res) => res.json(listFor(req.user.id)));

router.post('/', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Nama grup wajib diisi' });
  if (circlesOf(req.user.id).length >= MAX_CIRCLES_PER_USER) {
    return res.status(400).json({ error: `Maksimal ${MAX_CIRCLES_PER_USER} grup per akun` });
  }
  db.transaction(() => {
    let code = newCode();
    while (db.prepare('SELECT 1 FROM circles WHERE code = ?').get(code)) code = newCode();
    const id = db.prepare('INSERT INTO circles (name, code, created_at) VALUES (?, ?, ?)').run(name, code, Date.now()).lastInsertRowid;
    db.prepare('INSERT INTO circle_members (circle_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, req.user.id, Date.now());
  })();
  res.json(listFor(req.user.id));
});

router.post('/join', (req, res) => {
  const code = String((req.body && req.body.code) || '').trim().toUpperCase();
  const circle = db.prepare('SELECT * FROM circles WHERE code = ?').get(code);
  if (!circle) return res.status(404).json({ error: 'Kode undangan tidak ditemukan' });
  if (db.prepare('SELECT 1 FROM circle_members WHERE circle_id = ? AND user_id = ?').get(circle.id, req.user.id)) {
    return res.status(409).json({ error: 'Kamu sudah ada di grup ini' });
  }
  if (circlesOf(req.user.id).length >= MAX_CIRCLES_PER_USER) {
    return res.status(400).json({ error: `Maksimal ${MAX_CIRCLES_PER_USER} grup per akun` });
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM circle_members WHERE circle_id = ?').get(circle.id).n >= MAX_MEMBERS) {
    return res.status(400).json({ error: 'Grup ini sudah penuh' });
  }
  db.prepare('INSERT INTO circle_members (circle_id, user_id, joined_at) VALUES (?, ?, ?)').run(circle.id, req.user.id, Date.now());
  res.json(listFor(req.user.id));
});

// Leaving is per member; the circle itself goes away with its last member.
router.delete('/:id/membership', (req, res) => {
  const id = Number(req.params.id);
  db.transaction(() => {
    db.prepare('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?').run(id, req.user.id);
    if (db.prepare('SELECT COUNT(*) AS n FROM circle_members WHERE circle_id = ?').get(id).n === 0) {
      db.prepare('DELETE FROM circles WHERE id = ?').run(id);
    }
  })();
  res.json(listFor(req.user.id));
});

module.exports = { router };
