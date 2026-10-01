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
const sameHex = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const hashPassword = async (password, salt) => (await scrypt(password, salt, 64)).toString('hex');
// ALLOW_SIGNUP=false closes registration once everyone is in. The very first account can always
// be created, otherwise a fresh install could never be used.
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const signupOpen = () => userCount() === 0 || String(process.env.ALLOW_SIGNUP || 'true').toLowerCase() !== 'false';

// SIGNUP_CODE turns registration into invite-only: an account can only be created by someone
// who was given the code. On a server open to the internet this is what keeps strangers out.
const signupCode = () => String(process.env.SIGNUP_CODE || '');
const codeMatches = (given) => sameHex(sha256(String(given || '')), sha256(signupCode()));

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

/** Replaces a user's password. Used by the routes below and by scripts/reset-password.js. */
async function setPassword(userId, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').run(await hashPassword(password, salt), salt, userId);
}
async function passwordMatches(userId, password) {
  const user = db.prepare('SELECT pass_hash, pass_salt FROM users WHERE id = ?').get(userId);
  return !!user && sameHex(await hashPassword(String(password || ''), user.pass_salt), user.pass_hash);
}

// The personal question is the "forgot my password" path: there is no email on file, so a
// question only the account holder can answer takes its place. The answer is treated like a
// second password — hashed with scrypt and its own salt, never stored or sent back — but
// compared forgivingly: "Si Putih", "si putih" and "siputih!" are the same answer.
const normalizeAnswer = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const cleanQuestion = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 120);
const QUESTION_PROBLEM = { error: 'Pertanyaan pribadinya minimal 5 karakter dan jawabannya minimal 2 huruf, ya.' };
const validQuestion = (question, answer) => cleanQuestion(question).length >= 5 && normalizeAnswer(answer).length >= 2 && String(answer).length <= 100;
async function setQuestion(userId, question, answer) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET secret_question = ?, secret_hash = ?, secret_salt = ? WHERE id = ?')
    .run(cleanQuestion(question), await hashPassword(normalizeAnswer(answer), salt), salt, userId);
}
// Shown for a name that has no account (or no question), picked by the name so it is always the
// same one: the sign-in screen must not reveal which usernames exist.
const DECOY_QUESTIONS = [
  'Apa nama hewan peliharaan pertamamu?',
  'Apa makanan favoritmu waktu kecil?',
  'Siapa nama sahabat masa kecilmu?',
  'Apa nama sekolah dasarmu?',
  'Siapa nama guru yang paling kamu ingat?',
];
const decoyQuestion = (username) => DECOY_QUESTIONS[parseInt(sha256(username).slice(0, 8), 16) % DECOY_QUESTIONS.length];

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
// Guessing a personal answer is far easier than guessing a password, so it gets far fewer
// tries: 5 an hour for one account from one address, and 15 an hour for the account overall.
const answerTries = limiter(5, 60 * 60 * 1000);
const answerTriesPerAccount = limiter(15, 60 * 60 * 1000);
const TOO_MANY = { error: 'Terlalu banyak percobaan. Istirahat dulu sekitar 10 menit, lalu coba lagi, ya.' };
const WEAK_PASSWORD = { error: 'Kata sandinya minimal 8 karakter, ya. Biar jurnalmu aman.' };
const validPassword = (p) => p.length >= 8 && p.length <= 200;

/** Rejects the request with 401 unless it carries a live session; sets req.user otherwise. */
function requireUser(req, res, next) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const user = db.prepare(`
      SELECT u.id, u.username, u.name, u.created_at AS createdAt, u.secret_question AS question
      FROM sessions s JOIN users u ON u.id = s.user_id
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
    if (codeGuesses.blocked(req.ip)) return res.status(429).json(TOO_MANY);
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
  if (!validPassword(password)) return res.status(400).json(WEAK_PASSWORD);
  // The page always asks for a personal question; when one is sent it has to be usable.
  const wantsQuestion = body.question || body.answer;
  if (wantsQuestion && !validQuestion(body.question, body.answer)) return res.status(400).json(QUESTION_PROBLEM);
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
  if (wantsQuestion) await setQuestion(userId, body.question, body.answer);
  startSession(req, res, userId);
  res.json({ id: Number(userId), username, name });
}));

router.post('/login', wrap(async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const key = `${username}|${req.ip}`;
  if (loginFailures.blocked(key)) return res.status(429).json(TOO_MANY);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // Hash even when the user does not exist, so the response time does not reveal which names are taken.
  const hash = await hashPassword(password, user ? user.pass_salt : 'no-such-user');
  const ok = !!user && sameHex(hash, user.pass_hash);
  if (!ok) {
    loginFailures.hit(key);
    return res.status(401).json({ error: 'Nama pengguna atau kata sandinya belum cocok. Coba lagi pelan-pelan, ya.' });
  }
  loginFailures.clear(key);
  startSession(req, res, user.id);
  res.json({ id: user.id, username: user.username, name: user.name });
}));

// Forgot password, step 1: which question belongs to this username. An unknown name gets a
// plausible question too (always the same one), so this cannot be used to find out who has an account.
router.get('/question', (req, res) => {
  const username = String(req.query.username || '').trim().toLowerCase();
  const user = db.prepare('SELECT secret_question FROM users WHERE username = ?').get(username);
  res.json({ question: (user && user.secret_question) || decoyQuestion(username) });
});

// Forgot password, step 2: the right answer sets a new password, signs in, and ends every
// other session. Wrong answers are tightly limited.
router.post('/reset', wrap(async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const key = `${username}|${req.ip}`;
  if (answerTries.blocked(key) || answerTriesPerAccount.blocked(username)) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan untuk akun ini. Coba lagi sekitar satu jam lagi, ya.' });
  }
  if (!validPassword(password)) return res.status(400).json(WEAK_PASSWORD);
  const user = db.prepare('SELECT id, username, name, secret_hash, secret_salt FROM users WHERE username = ?').get(username);
  // Hash even when there is nothing to compare with, and answer the same way whether the name
  // or the answer is wrong, so neither the timing nor the message reveals which names exist.
  const hash = await hashPassword(normalizeAnswer(body.answer), (user && user.secret_salt) || 'no-such-user');
  if (!user || !user.secret_hash || !sameHex(hash, user.secret_hash)) {
    answerTries.hit(key); answerTriesPerAccount.hit(username);
    return res.status(401).json({ error: 'Jawabannya belum cocok. Coba ingat-ingat lagi pelan-pelan, ya.' });
  }
  answerTries.clear(key);
  await setPassword(user.id, password);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
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

// Anything that changes who can get into the account asks for the current password again.
// Wrong guesses are counted like failed sign-ins. Answers the request itself when it fails.
async function confirmPassword(req, res, password) {
  const key = `password|${req.user.id}`;
  if (loginFailures.blocked(key)) { res.status(429).json(TOO_MANY); return false; }
  if (!(await passwordMatches(req.user.id, password))) {
    loginFailures.hit(key);
    res.status(403).json({ error: 'Kata sandi yang sekarang belum cocok. Coba lagi pelan-pelan, ya.' });
    return false;
  }
  loginFailures.clear(key);
  return true;
}

account.patch('/profile', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: 'Nama panggilannya belum diisi. Tulis nama yang kamu suka, ya.' });
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ ...req.user, name });
});

account.post('/password', wrap(async (req, res) => {
  const body = req.body || {};
  const next = String(body.next || '');
  if (!validPassword(next)) return res.status(400).json(WEAK_PASSWORD);
  if (!(await confirmPassword(req, res, body.current))) return;
  await setPassword(req.user.id, next);
  // Anyone still signed in elsewhere with the old password is signed out; this device stays in.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, sha256(readCookie(req, COOKIE) || ''));
  res.json({ ok: true });
}));

// Sets or replaces the personal question used when the password is forgotten.
account.post('/question', wrap(async (req, res) => {
  const body = req.body || {};
  if (!validQuestion(body.question, body.answer)) return res.status(400).json(QUESTION_PROBLEM);
  if (!(await confirmPassword(req, res, body.password))) return;
  await setQuestion(req.user.id, body.question, body.answer);
  res.json({ question: cleanQuestion(body.question) });
}));

// Deletes the account and everything that belongs to it. A circle left without members goes too.
account.delete('/', wrap(async (req, res) => {
  if (!(await confirmPassword(req, res, req.body && req.body.password))) return;
  const id = req.user.id;
  db.transaction(() => {
    for (const table of ['photos', 'entries', 'settings', 'sessions', 'circle_members']) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(id);
    }
    db.prepare('DELETE FROM circles WHERE id NOT IN (SELECT circle_id FROM circle_members)').run();
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
}));

module.exports = { router, account, requireUser, wrap, limiter, setPassword };
