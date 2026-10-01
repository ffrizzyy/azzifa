require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const { generateText, providerInfo, ProviderError } = require('./ai');
const auth = require('./auth');
const circles = require('./circles');
const photos = require('./photos');
const { isRealDay, shiftDay, mondayOf, clientDay } = require('./day');

const app = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');
// On a hosting platform the app sits behind the platform's proxy, which is the only thing that
// knows the visitor's real address and whether they came in over HTTPS. TRUST_PROXY says how many
// such proxies to believe (usually 1). Leave it unset when the app is reached directly: believing
// a proxy that is not there would let anyone fake their address and dodge the rate limits.
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

// A private journal should not be framed, sniffed, or allowed to load code from elsewhere.
// The page is one file with inline script and styles, hence 'unsafe-inline'; everything else
// is limited to this server plus the Google Fonts stylesheet and font files.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Once a browser has reached the journal over HTTPS, it should never fall back to plain HTTP.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '));
  next();
});

// A restored backup can be far larger than any single request the app itself makes,
// so /api/import brings its own body parser with a higher limit.
const jsonBody = express.json({ limit: '1mb' });
app.use((req, res, next) => (req.path === '/api/import' ? next() : jsonBody(req, res, next)));
app.use(express.static(path.join(__dirname, '..', 'public')));

// For a container/uptime check — returns fast, touches nothing.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Everything under /api belongs to the signed-in user, except signing in itself.
app.use('/api/auth', auth.router);
app.use('/api', auth.requireUser);
// "Today" is the caller's own date, not the server's (see day.js).
app.use('/api', (req, res, next) => { req.today = clientDay(req); next(); });
app.get('/api/me', (req, res) => res.json(req.user));
app.use('/api/circles', circles.router);
app.use('/api/photos', photos.router);

// A day can hold several separate notes now. Rows saved before that existed have
// a single prompt/text and no `notes` column — read them back as a one-note day.
function parseNotes(row) {
  try {
    const n = JSON.parse(row.notes || 'null');
    if (Array.isArray(n) && n.length) return n;
  } catch (e) { /* fall through */ }
  return [{ prompt: row.prompt, text: row.text, at: row.updated_at }];
}
function rowToEntry(row) {
  const entry = { date: row.date, mood: row.mood, prompt: row.prompt, text: row.text, notes: parseNotes(row), updatedAt: row.updated_at };
  if (row.day_summary) {
    try { entry.daySummary = JSON.parse(row.day_summary); } catch (e) { /* ignore corrupt value */ }
  }
  return entry;
}
// Ids of every picture a stored day refers to.
const photoIdsOf = (row) => (row ? parseNotes(row).flatMap((n) => (Array.isArray(n.photos) ? n.photos : [])) : []);
const entryOn = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date = ?');

// ---------- Entries ----------
const MOOD_KEYS = ['berat', 'cemas', 'biasa', 'tenang', 'senang'];
const MAX_NOTES_PER_DAY = 50;
const upsertEntry = db.prepare(`
  INSERT INTO entries (user_id, date, mood, prompt, text, notes, day_summary, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, date) DO UPDATE SET mood=excluded.mood, prompt=excluded.prompt, text=excluded.text, notes=excluded.notes, day_summary=excluded.day_summary, updated_at=excluded.updated_at
`);

/**
 * Whatever a client or a backup file sends for one day, reduced to a row that is safe to store
 * and to render: a real date, a known mood, and notes holding only the fields the app uses.
 * A note may be words, pictures, or both; pictures must already be uploaded by this user.
 * Returns null when there is nothing worth saving (bad date, or every note is empty).
 */
function entryRow(userId, raw) {
  if (!raw || !isRealDay(raw.date)) return null;
  const source = Array.isArray(raw.notes) && raw.notes.length ? raw.notes : [{ prompt: raw.prompt, text: raw.text, at: raw.updatedAt }];
  const notes = source
    .filter((n) => n && typeof n === 'object')
    .map((n) => {
      const pictures = photos.owned(userId, n.photos);
      return {
        prompt: typeof n.prompt === 'string' ? n.prompt.slice(0, 300) : '',
        text: typeof n.text === 'string' ? n.text : '',
        at: Number(n.at) || Date.now(),
        ...(n.fav ? { fav: true } : {}),
        ...(pictures.length ? { photos: pictures } : {}),
      };
    })
    .filter((n) => n.text.trim() || n.photos)
    .slice(0, MAX_NOTES_PER_DAY);
  if (notes.length === 0) return null;
  const summary = raw.daySummary && typeof raw.daySummary.text === 'string'
    ? JSON.stringify({ text: raw.daySummary.text, at: Number(raw.daySummary.at) || Date.now() })
    : null;
  return [
    userId, raw.date, MOOD_KEYS.includes(raw.mood) ? raw.mood : 'biasa', notes[0].prompt,
    notes.map((n) => n.text).filter(Boolean).join('\n\n'), JSON.stringify(notes), summary, Number(raw.updatedAt) || Date.now(),
  ];
}
// Saves one cleaned day and keeps the pictures table in step with what its notes now hold.
function saveEntry(row) {
  const [userId, date, , , , notesJson] = row;
  const before = photoIdsOf(entryOn.get(userId, date));
  upsertEntry.run(...row);
  photos.sync(userId, before, photoIdsOf({ notes: notesJson }));
}

app.get('/api/entries', (req, res) => {
  // Enough for several years of daily entries — "on this day" needs to see that far back.
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY date DESC LIMIT 2000').all(req.user.id);
  res.json(rows.map(rowToEntry));
});

app.put('/api/entries/:date', (req, res) => {
  if (!isRealDay(req.params.date)) {
    return res.status(400).json({ error: 'Tanggalnya belum dikenali. Coba muat ulang halamannya, ya.' });
  }
  const row = entryRow(req.user.id, { ...(req.body || {}), date: req.params.date, updatedAt: Date.now() });
  if (!row) return res.status(400).json({ error: 'Tulis dulu sedikit atau tambahkan foto, ya. Catatan kosong belum bisa disimpan.' });
  db.transaction(saveEntry)(row);
  res.json({ ok: true });
});

app.delete('/api/entries/:date', (req, res) => {
  db.transaction(() => {
    const before = photoIdsOf(entryOn.get(req.user.id, req.params.date));
    db.prepare('DELETE FROM entries WHERE user_id = ? AND date = ?').run(req.user.id, req.params.date);
    photos.sync(req.user.id, before, []);
  })();
  res.json({ ok: true });
});

// ---------- Settings (key/value, single row per user and key) ----------
function readSettings(userId) {
  const rows = db.prepare('SELECT key, value FROM settings WHERE user_id = ?').all(userId);
  const s = {};
  rows.forEach((r) => { s[r.key] = r.value; });
  return {
    reminderEnabled: s.reminderEnabled === '1',
    reminderTime: s.reminderTime || '20:00',
    insightWeek: s.insightWeek || null,
    insightText: s.insightText || null,
    summaryText: s.summaryText || null,
    summaryAt: s.summaryAt ? Number(s.summaryAt) : null,
    summaryRange: s.summaryRange ? Number(s.summaryRange) : 7,
    dayMode: s.dayMode === 'checkup' ? 'checkup' : 'daily', // Harian unless the user chose Check Up
    tourDone: s.tourDone === '1', // false until the first-visit tour has been finished or skipped
  };
}
// `ai` is not a setting the user owns: it tells the page whether the AI cards can work at all,
// and which provider's name belongs in the "your notes are sent to…" line.
const settingsFor = (userId) => ({ ...readSettings(userId), ai: providerInfo() });
const upsertSetting = db.prepare(`
  INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
  ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value
`);

app.get('/api/settings', (req, res) => res.json(settingsFor(req.user.id)));

app.put('/api/settings', (req, res) => {
  const patch = req.body || {};
  const tx = db.transaction((pairs) => { pairs.forEach(([k, v]) => upsertSetting.run(req.user.id, k, v)); });
  const pairs = [];
  if ('reminderEnabled' in patch) pairs.push(['reminderEnabled', patch.reminderEnabled ? '1' : '0']);
  if ('reminderTime' in patch && /^\d{2}:\d{2}$/.test(String(patch.reminderTime))) pairs.push(['reminderTime', String(patch.reminderTime)]);
  if ('summaryRange' in patch) pairs.push(['summaryRange', Number(patch.summaryRange) === 30 ? '30' : '7']);
  if ('dayMode' in patch) pairs.push(['dayMode', patch.dayMode === 'daily' ? 'daily' : 'checkup']);
  if ('tourDone' in patch) pairs.push(['tourDone', patch.tourDone ? '1' : '0']);
  tx(pairs);
  res.json(settingsFor(req.user.id));
});

// ---------- Export ----------
app.get('/api/export.txt', (req, res) => {
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY date ASC').all(req.user.id);
  const fmt = (d, timeZone) => new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone });
  const fmtDay = (day) => fmt(`${day}T00:00:00Z`, 'UTC'); // a calendar date, so no timezone shift
  const totalNotes = rows.reduce((n, r) => n + parseNotes(r).length, 0);
  let out = `Azzifa — Catatan Refleksi\nDiekspor: ${fmtDay(req.today)}\nTotal catatan: ${totalNotes}\n\n`;
  rows.forEach((r) => {
    out += `${fmtDay(r.date)} — Mood: ${r.mood}\n`;
    parseNotes(r).forEach((n) => {
      const pictures = Array.isArray(n.photos) && n.photos.length ? `[${n.photos.length} foto]\n` : '';
      out += `Pertanyaan: ${n.prompt}\n${n.text ? `${n.text}\n` : ''}${pictures}\n`;
    });
  });
  const settings = readSettings(req.user.id);
  if (settings.summaryText) {
    out += `Rangkuman kegiatan (${fmt(settings.summaryAt)}, ${settings.summaryRange} hari terakhir)\n${settings.summaryText}\n`;
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="azzifa-riwayat.txt"');
  res.send(out);
});

// ---------- Backup and restore ----------
// Unlike export.txt this round-trips: every entry with its notes, favourites and day summary,
// plus the pictures those notes hold (base64, so the backup is one self-contained file).
app.get('/api/export.json', (req, res) => {
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY date ASC').all(req.user.id);
  res.setHeader('Content-Disposition', `attachment; filename="azzifa-cadangan-${req.today}.json"`);
  res.json({
    app: 'azzifa', version: 2, exportedAt: Date.now(),
    entries: rows.map(rowToEntry),
    photos: photos.exportFor(req.user.id, rows.flatMap(photoIdsOf)),
  });
});

// Restores a backup into the signed-in user's journal. A date already there is replaced by the
// backup's version; dates the backup does not mention are left alone. Malformed entries are
// skipped, not fatal. Pictures go in first, so the notes that refer to them can claim them.
app.post('/api/import', express.json({ limit: '200mb' }), (req, res) => {
  const list = Array.isArray(req.body) ? req.body : req.body && req.body.entries;
  if (!Array.isArray(list) || list.length === 0) {
    return res.status(400).json({ error: 'File cadangannya belum berisi catatan.' });
  }
  const result = db.transaction(() => {
    photos.restoreFor(req.user.id, req.body.photos);
    const clean = list.map((raw) => entryRow(req.user.id, raw)).filter(Boolean);
    clean.forEach(saveEntry);
    return clean.length;
  })();
  if (result === 0) {
    return res.status(400).json({ error: 'Belum ada catatan yang bisa dibaca dari file cadangan ini.' });
  }
  res.json({ ok: true, imported: result, skipped: list.length - result });
});

// ---------- AI ----------
// Every account shares the server owner's API key, so each one gets a daily allowance.
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 30;
const aiCalls = auth.limiter(AI_DAILY_LIMIT, 24 * 60 * 60 * 1000);

/** Runs one AI request for the signed-in user and answers with `{text, ...}` or a kind error. */
async function answerWithAi(req, res, prompt, maxTokens, onText) {
  const key = `${req.user.id}|${req.today}`;
  if (aiCalls.blocked(key)) {
    return res.status(429).json({ error: 'Hari ini AI sudah banyak membantu. Kita lanjut lagi besok, ya.' });
  }
  try {
    const text = await generateText(prompt, { maxTokens });
    aiCalls.hit(key);
    res.json(onText(text));
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    // The technical reason is for whoever runs the server, not for the person writing.
    console.error('AI:', e.message);
    if (e.kind === 'unconfigured') {
      return res.status(501).json({ error: 'Fitur AI belum diaktifkan di server ini. Catatanmu tetap tersimpan seperti biasa.' });
    }
    if (e.kind === 'refusal') {
      return res.status(422).json({ error: 'AI belum bisa merangkum catatan ini. Tidak apa-apa, catatanmu tetap aman.' });
    }
    res.status(502).json({ error: 'AI sedang sulit dihubungi. Coba lagi sebentar lagi, ya.' });
  }
}

// Weekly pattern observation (Dashboard)
app.post('/api/insight', auth.wrap(async (req, res) => {
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY date DESC LIMIT 14').all(req.user.id);
  const totalNotes = rows.reduce((n, r) => n + parseNotes(r).length, 0);
  if (totalNotes < 3) {
    return res.status(400).json({ error: 'Tulis minimal 3 catatan dulu, ya. Setelah itu pengamatan bisa dibuat.' });
  }
  const material = rows.map((r) => `${r.date} (${r.mood}): ${parseNotes(r).map((n) => n.text).join(' / ')}`).join('\n').slice(0, 9000);
  const prompt = `Berdasarkan catatan jurnal berikut, tulis satu pengamatan pola singkat (2-3 kalimat, bahasa Indonesia, nada hangat dan suportif, bukan menghakimi) tentang mood orang ini akhir-akhir ini. Jangan mendiagnosis, jangan memberi saran medis. Tanpa markdown. Catatan:\n${material}`;
  await answerWithAi(req, res, prompt, 300, (text) => {
    const week = mondayOf(req.today);
    upsertSetting.run(req.user.id, 'insightWeek', week);
    upsertSetting.run(req.user.id, 'insightText', text);
    return { week, text };
  });
}));

// Activity summary over a date range (Riwayat)
app.post('/api/summary', auth.wrap(async (req, res) => {
  const range = req.body && Number(req.body.range) === 30 ? 30 : 7;
  const since = shiftDay(req.today, -(range - 1));
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date >= ? ORDER BY date ASC').all(req.user.id, since);
  if (rows.length === 0) {
    return res.status(400).json({ error: 'Belum ada catatan di rentang ini. Coba pilih rentang yang lebih panjang, ya.' });
  }
  const material = rows.map((r) => {
    const notes = parseNotes(r).map((n) => `- Pertanyaan: ${n.prompt}\n  Jawaban: ${String(n.text).slice(0, 600)}`).join('\n');
    return `${r.date} (mood: ${r.mood})\n${notes}`;
  }).join('\n\n').slice(0, 9000);
  const prompt = `Kamu merangkum jurnal harian seseorang dalam bahasa Indonesia yang natural dan hangat. Tugasmu: rangkum KEGIATAN sehari-hari dari catatan di bawah.\nAturan:\n1. Tulis satu baris untuk setiap tanggal yang punya catatan, diawali tanggal singkat (contoh: "Sen 28 Sep:"), lalu satu kalimat tentang apa yang dikerjakan atau dialami hari itu.\n2. Setelah itu tulis satu paragraf pendek (2-3 kalimat) diawali "Gambaran umum:" tentang pola kegiatan atau hal yang sering muncul.\n3. Hanya pakai hal yang benar-benar tertulis. Jangan mengarang, jangan mendiagnosis, jangan memberi saran medis.\n4. Tanpa markdown, tanpa tanda bintang, tanpa judul.\n\nCatatan:\n${material}`;
  await answerWithAi(req, res, prompt, 500, (text) => {
    const at = Date.now();
    upsertSetting.run(req.user.id, 'summaryText', text);
    upsertSetting.run(req.user.id, 'summaryAt', String(at));
    upsertSetting.run(req.user.id, 'summaryRange', String(range));
    return { text, at };
  });
}));

// Same-day recap ("Harian" mode, Hari ini tab). Distinct from /api/summary: this covers exactly
// one date and lives on that entry row (day_summary column), not in the settings table, so it
// never clashes with the 7/30-day summary.
app.post('/api/entries/:date/day-summary', auth.wrap(async (req, res) => {
  const { date } = req.params;
  const row = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date = ?').get(req.user.id, date);
  if (!row) return res.status(400).json({ error: 'Belum ada catatan hari ini. Tulis dulu sedikit, ya.' });
  const material = parseNotes(row).map((n) => `- ${n.prompt}\n  ${n.text}`).join('\n').slice(0, 9000);
  const prompt = `Rangkum kegiatan HARI INI saja (bukan beberapa hari) dalam 2-4 kalimat yang mengalir seperti cerita singkat, bahasa Indonesia yang natural dan hangat. Hanya pakai hal yang benar-benar tertulis di catatan, jangan mengarang, jangan mendiagnosis, jangan memberi saran medis. Tanpa markdown, tanpa judul.\n\nCatatan hari ini:\n${material}`;
  await answerWithAi(req, res, prompt, 300, (text) => {
    const at = Date.now();
    db.prepare('UPDATE entries SET day_summary = ? WHERE user_id = ? AND date = ?').run(JSON.stringify({ text, at }), req.user.id, date);
    return { text, at };
  });
}));

// ---------- Fallbacks ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Alamat itu tidak ada di Azzifa.' }));

// Every failure answers in JSON the page can show, in the app's own voice.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Kirimannya terlalu besar untuk diterima sekaligus.' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Kirimannya tidak terbaca. Coba ulangi sekali lagi, ya.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Ada yang belum beres di server. Catatanmu aman, coba lagi sebentar lagi, ya.' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Azzifa berjalan di http://localhost:${PORT}`);
});

// A platform stops the app with SIGTERM on every deploy and restart. Finish the requests in
// flight and close the database cleanly, so nothing half-written is left behind.
function shutDown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 10000).unref(); // a stuck connection must not block the restart
}
process.on('SIGTERM', shutDown);
process.on('SIGINT', shutDown);
