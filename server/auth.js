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

// SIGNUP_CODE turns registration into invite-only: an account can only be created by someone
// who was given the code. On a server open to the internet this is what keeps strangers out.
const signupCode = () => String(process.env.SIGNUP_CODE || '');
const codeMatches = (given) => crypto.timingSafeEqual(Buffer.from(sha256(String(given || ''))), Buffer.from(sha256(signupCode())));

// Express 4 does not catch a rejected promise from an async handler: without this the request
// would hang and the rejection would take the whole process down.
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

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

/**
 * A small in-memory attempt counter: `max` hits per `windowMs` for each key. A restart clears
 * it, and so does growing past 10,000 keys — it only has to slow abuse down, not keep records.
 */
function limiter(max, windowMs) {
  const hits = new Map();
  const live = (key) => {
    const h = hits.get(key);
    if (h && Date.now() - h.first > windowMs) { hits.delete(key); return null; }
    return h;
  };
  return {
    blocked: (key) => (live(key)?.count || 0) >= max,
    hit: (key) => {
      if (hits.size > 10000) hits.clear();
      const h = live(key);
      if (h) h.count += 1; else hits.set(key, { count: 1, first: Date.now() });
    },
    clear: (key) => hits.delete(key),
  };
}
// Password guessing: 8 failures for one username from one address locks that pair for 10 minutes.
const loginFailures = limiter(8, 10 * 60 * 1000);
// Account creation: 10 per hour from one address by default, since each one costs a password
// hash and a row. Behind a reverse proxy every visitor shares the proxy's address, so a busy
// server may need SIGNUPS_PER_HOUR raised.
const signups = limiter(Number(process.env.SIGNUPS_PER_HOUR) || 10, 60 * 60 * 1000);
// Guessing the sign-up code: 10 wrong tries from one address, then a 10 minute pause.
const codeGuesses = limiter(10, 10 * 60 * 1000);

/** Rejects the request with 401 unless it carries a live session; sets req.user otherwise. */
function requireUser(req, res, next) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const user = db.prepare(`
      SELECT u.id, u.username, u.name, u.created_at AS createdAt FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(sha256(token), Date.now());
    if (user) { req.user = user; return next(); }
  }
  res.status(401).json({ error: 'Sesi kamu sudah berakhir. Masuk lagi dulu, ya.' });
}

const router = express.Router();

// Lets the sign-in screen know what to offer before anyone is logged in.
router.get('/config', (req, res) => {
  res.json({ signup: signupOpen(), firstAccount: userCount() === 0, needsCode: !!signupCode() });
});

router.post('/register', wrap(async (req, res) => {
  if (!signupOpen()) return res.status(403).json({ error: 'Pendaftaran akun baru sedang ditutup. Coba hubungi pemilik server ini, ya.' });
  if (signups.blocked(req.ip)) return res.status(429).json({ error: 'Sudah banyak akun dibuat dari sini. Coba lagi nanti, ya.' });
  const body = req.body || {};
  if (signupCode()) {
    if (codeGuesses.blocked(req.ip)) return res.status(429).json({ error: 'Terlalu banyak percobaan. Istirahat dulu sekitar 10 menit, lalu coba lagi, ya.' });
    if (!codeMatches(body.code)) {
      codeGuesses.hit(req.ip);
      return res.status(403).json({ error: 'Kode pendaftarannya belum cocok. Minta kodenya ke pemilik server ini, ya.' });
    }
  }
  const username = String(body.username || '').trim().toLowerCase();
  const name = String(body.name || '').trim().slice(0, 30) || username;
  const password = String(body.password || '');
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Nama pengguna perlu 3-24 karakter: huruf kecil, angka, titik, strip, atau garis bawah.' });
  }
  if (password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Kata sandinya minimal 8 karakter, ya. Biar jurnalmu aman.' });
  }
  const taken = { error: 'Nama pengguna itu sudah ada yang pakai. Coba nama lain, ya.' };
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json(taken);
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
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json(taken); // lost a race for the name
    throw e;
  }
  signups.hit(req.ip);
  startSession(req, res, userId);
  res.json({ id: Number(userId), username, name });
}));

router.post('/login', wrap(async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const key = `${username}|${req.ip}`;
  if (loginFailures.blocked(key)) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan. Istirahat dulu sekitar 10 menit, lalu coba lagi, ya.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // Hash even when the user does not exist, so the response time does not reveal which names are taken.
  const hash = await hashPassword(password, user ? user.pass_salt : 'no-such-user');
  const ok = !!user && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.pass_hash, 'hex'));
  if (!ok) {
    loginFailures.hit(key);
    return res.status(401).json({ error: 'Nama pengguna atau kata sandinya belum cocok. Coba lagi pelan-pelan, ya.' });
  }
  loginFailures.clear(key);
  startSession(req, res, user.id);
  res.json({ id: user.id, username: user.username, name: user.name });
}));

router.post('/logout', (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

// ---------- The signed-in account (mounted behind requireUser, at /api/account) ----------
const account = express.Router();

account.patch('/profile', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: 'Nama panggilannya belum diisi. Tulis nama yang kamu suka, ya.' });
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ ...req.user, name });
});

// Wrong guesses at the current password are counted like failed sign-ins.
account.post('/password', wrap(async (req, res) => {
  const body = req.body || {};
  const current = String(body.current || '');
  const next = String(body.next || '');
  const key = `password|${req.user.id}`;
  if (loginFailures.blocked(key)) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan. Istirahat dulu sekitar 10 menit, lalu coba lagi, ya.' });
  }
  if (next.length < 8 || next.length > 200) {
    return res.status(400).json({ error: 'Kata sandi barunya minimal 8 karakter, ya. Biar jurnalmu aman.' });
  }
  const user = db.prepare('SELECT pass_hash, pass_salt FROM users WHERE id = ?').get(req.user.id);
  const hash = await hashPassword(current, user.pass_salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.pass_hash, 'hex'))) {
    loginFailures.hit(key);
    return res.status(403).json({ error: 'Kata sandi yang sekarang belum cocok. Coba lagi pelan-pelan, ya.' });
  }
  loginFailures.clear(key);
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').run(await hashPassword(next, salt), salt, req.user.id);
  // Anyone still signed in elsewhere with the old password is signed out; this device stays in.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, sha256(readCookie(req, COOKIE) || ''));
  res.json({ ok: true });
}));

module.exports = { router, account, requireUser, wrap, limiter };
