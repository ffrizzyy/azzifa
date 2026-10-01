// Accounts and sessions. Passwords are scrypt-hashed with a per-user salt; a session is a random
// token kept in an HttpOnly cookie, of which the database only stores a SHA-256 hash.
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'azzifa_sid';
const SESSION_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const USERNAME_RE = /^[a-z0-9_.-]{3,24}$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPassword = async (password, salt) => (await scrypt(password, salt, 64)).toString('hex');
// ALLOW_SIGNUP=false closes registration once everyone is in. The very first account can always
// be created, otherwise a fresh install could never be used.
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const signupOpen = () => userCount() === 0 || String(process.env.ALLOW_SIGNUP || 'true').toLowerCase() !== 'false';

function readCookie(req, name) {
  const parts = (req.headers.cookie || '').split(';');
  for (const part of parts) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function setSessionCookie(req, res, token, maxAgeMs) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`);
}
function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + SESSION_MS);
  setSessionCookie(req, res, token, SESSION_MS);
}

// Slows down password guessing: after 8 failures for one username from one address,
// that pair is locked out for 10 minutes. In memory only — a restart clears it.
const failures = new Map();
const MAX_FAILS = 8;
const LOCK_MS = 10 * 60 * 1000;
function isLocked(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > LOCK_MS) { failures.delete(key); return false; }
  return f.count >= MAX_FAILS;
}
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > LOCK_MS) failures.set(key, { count: 1, first: Date.now() });
  else f.count += 1;
}

/** Rejects the request with 401 unless it carries a live session; sets req.user otherwise. */
function requireUser(req, res, next) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const user = db.prepare(`
      SELECT u.id, u.username, u.name FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(sha256(token), Date.now());
    if (user) { req.user = user; return next(); }
  }
  res.status(401).json({ error: 'Kamu belum masuk' });
}

const router = express.Router();

// Lets the sign-in screen know what to offer before anyone is logged in.
router.get('/config', (req, res) => {
  res.json({ signup: signupOpen(), firstAccount: userCount() === 0 });
});

router.post('/register', async (req, res) => {
  if (!signupOpen()) return res.status(403).json({ error: 'Pendaftaran akun baru sedang ditutup' });
  const body = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  const name = String(body.name || '').trim().slice(0, 30) || username;
  const password = String(body.password || '');
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Nama pengguna 3-24 karakter: huruf kecil, angka, titik, strip, atau garis bawah' });
  }
  if (password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Kata sandi minimal 8 karakter' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'Nama pengguna itu sudah dipakai' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPassword(password, salt);
  let userId;
  try {
    userId = db.transaction(() => {
      const first = userCount() === 0;
      const id = db.prepare('INSERT INTO users (username, name, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(username, name, hash, salt, Date.now()).lastInsertRowid;
      if (first) {
        // The journal written before accounts existed belongs to whoever sets the server up.
        db.prepare('UPDATE entries SET user_id = ? WHERE user_id = 0').run(id);
        db.prepare('UPDATE settings SET user_id = ? WHERE user_id = 0').run(id);
      }
      return id;
    })();
  } catch (e) {
    // Two registrations for the same username raced past the check above.
    return res.status(409).json({ error: 'Nama pengguna itu sudah dipakai' });
  }
  startSession(req, res, userId);
  res.json({ id: Number(userId), username, name });
});

router.post('/login', async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const key = `${username}|${req.ip}`;
  if (isLocked(key)) return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi 10 menit lagi.' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // Hash even when the user does not exist, so the response time does not reveal which names are taken.
  const hash = await hashPassword(password, user ? user.pass_salt : 'no-such-user');
  const ok = !!user && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.pass_hash, 'hex'));
  if (!ok) {
    recordFailure(key);
    return res.status(401).json({ error: 'Nama pengguna atau kata sandi salah' });
  }
  failures.delete(key);
  startSession(req, res, user.id);
  res.json({ id: user.id, username: user.username, name: user.name });
});

router.post('/logout', (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

module.exports = { router, requireUser };
