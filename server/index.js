require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const { generateText, ProviderError } = require('./ai');
const auth = require('./auth');
const circles = require('./circles');

const app = express();
const PORT = process.env.PORT || 3000;

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
app.get('/api/me', (req, res) => res.json(req.user));
app.use('/api/circles', circles.router);

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

// ---------- Entries ----------
const upsertEntry = db.prepare(`
  INSERT INTO entries (user_id, date, mood, prompt, text, notes, day_summary, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, date) DO UPDATE SET mood=excluded.mood, prompt=excluded.prompt, text=excluded.text, notes=excluded.notes, day_summary=excluded.day_summary, updated_at=excluded.updated_at
`);

app.get('/api/entries', (req, res) => {
  // Enough for several years of daily entries — "on this day" needs to see that far back.
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY date DESC LIMIT 2000').all(req.user.id);
  res.json(rows.map(rowToEntry));
});

app.put('/api/entries/:date', (req, res) => {
  const { date } = req.params;
  const { mood, prompt, text, notes, daySummary } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text wajib diisi' });
  }
  const notesJson = Array.isArray(notes) && notes.length
    ? JSON.stringify(notes)
    : JSON.stringify([{ prompt: prompt || '', text, at: Date.now() }]);
  const daySummaryJson = daySummary ? JSON.stringify(daySummary) : null;
  upsertEntry.run(req.user.id, date, mood || 'biasa', prompt || '', text, notesJson, daySummaryJson, Date.now());
  res.json({ ok: true });
});

app.delete('/api/entries/:date', (req, res) => {
  db.prepare('DELETE FROM entries WHERE user_id = ? AND date = ?').run(req.user.id, req.params.date);
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
    dayMode: s.dayMode === 'daily' ? 'daily' : 'checkup',
  };
}
const upsertSetting = db.prepare(`
  INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
  ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value
`);

app.get('/api/settings', (req, res) => res.json(readSettings(req.user.id)));

app.put('/api/settings', (req, res) => {
  const patch = req.body || {};
  const tx = db.transaction((pairs) => { pairs.forEach(([k, v]) => upsertSetting.run(req.user.id, k, v)); });
  const pairs = [];
  if ('reminderEnabled' in patch) pairs.push(['reminderEnabled', patch.reminderEnabled ? '1' : '0']);
  if ('reminderTime' in patch) pairs.push(['reminderTime', String(patch.reminderTime)]);
  if ('insightWeek' in patch) pairs.push(['insightWeek', String(patch.insightWeek)]);
  if ('insightText' in patch) pairs.push(['insightText', String(patch.insightText)]);
  if ('summaryText' in patch) pairs.push(['summaryText', String(patch.summaryText)]);
  if ('summaryAt' in patch) pairs.push(['summaryAt', String(patch.summaryAt)]);
  if ('summaryRange' in patch) pairs.push(['summaryRange', String(patch.summaryRange)]);
  if ('dayMode' in patch) pairs.push(['dayMode', patch.dayMode === 'daily' ? 'daily' : 'checkup']);
  tx(pairs);
  res.json(readSettings(req.user.id));
});

// ---------- Export ----------
app.get('/api/export.txt', (req, res) => {
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY date ASC').all(req.user.id);
  const fmt = (d) => new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  const totalNotes = rows.reduce((n, r) => n + parseNotes(r).length, 0);
  let out = `Azzifa — Catatan Refleksi\nDiekspor: ${fmt(new Date())}\nTotal catatan: ${totalNotes}\n\n`;
  rows.forEach((r) => {
    out += `${fmt(r.date)} — Mood: ${r.mood}\n`;
    parseNotes(r).forEach((n) => { out += `Pertanyaan: ${n.prompt}\n${n.text}\n\n`; });
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
// Unlike export.txt this round-trips: every entry with its notes, favourites and day summary.
app.get('/api/export.json', (req, res) => {
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY date ASC').all(req.user.id);
  res.setHeader('Content-Disposition', `attachment; filename="azzifa-cadangan-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ app: 'azzifa', version: 1, exportedAt: Date.now(), entries: rows.map(rowToEntry) });
});

const MOOD_KEYS = ['berat', 'cemas', 'biasa', 'tenang', 'senang'];

// Restores a backup into the signed-in user's journal. A date already there is replaced by the
// backup's version; dates the backup does not mention are left alone. Malformed entries are
// skipped, not fatal.
app.post('/api/import', express.json({ limit: '25mb' }), (req, res) => {
  const list = Array.isArray(req.body) ? req.body : req.body && req.body.entries;
  if (!Array.isArray(list) || list.length === 0) {
    return res.status(400).json({ error: 'File cadangan tidak berisi catatan' });
  }
  const clean = [];
  list.forEach((raw) => {
    if (!raw || typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return;
    const source = Array.isArray(raw.notes) && raw.notes.length ? raw.notes : [{ prompt: raw.prompt, text: raw.text, at: raw.updatedAt }];
    const notes = source
      .filter((n) => n && typeof n.text === 'string' && n.text.trim())
      .map((n) => ({ prompt: typeof n.prompt === 'string' ? n.prompt : '', text: n.text, at: Number(n.at) || Date.now(), ...(n.fav ? { fav: true } : {}) }));
    if (notes.length === 0) return;
    const ds = raw.daySummary && typeof raw.daySummary.text === 'string'
      ? JSON.stringify({ text: raw.daySummary.text, at: Number(raw.daySummary.at) || Date.now() })
      : null;
    clean.push([
      req.user.id, raw.date, MOOD_KEYS.includes(raw.mood) ? raw.mood : 'biasa', notes[0].prompt,
      notes.map((n) => n.text).join('\n\n'), JSON.stringify(notes), ds, Number(raw.updatedAt) || Date.now(),
    ]);
  });
  if (clean.length === 0) {
    return res.status(400).json({ error: 'Tidak ada catatan yang valid di file cadangan' });
  }
  db.transaction((rows) => { rows.forEach((r) => upsertEntry.run(...r)); })(clean);
  res.json({ ok: true, imported: clean.length, skipped: list.length - clean.length });
});

// ---------- Weekly AI pattern observation (Dashboard) ----------
function currentWeekKey() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

app.post('/api/insight', async (req, res) => {
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY date DESC LIMIT 14').all(req.user.id);
  const totalNotes = rows.reduce((n, r) => n + parseNotes(r).length, 0);
  if (totalNotes < 3) {
    return res.status(400).json({ error: 'Minimal 3 catatan diperlukan sebelum pengamatan bisa dibuat' });
  }
  const material = rows.map((r) => `${r.date} (${r.mood}): ${parseNotes(r).map((n) => n.text).join(' / ')}`).join('\n');
  const prompt = `Berdasarkan catatan jurnal berikut, tulis satu pengamatan pola singkat (2-3 kalimat, bahasa Indonesia, nada suportif bukan menghakimi) tentang mood orang ini akhir-akhir ini. Catatan:\n${material}`;
  try {
    const text = await generateText(prompt, { maxTokens: 300 });
    const week = currentWeekKey();
    upsertSetting.run(req.user.id, 'insightWeek', week);
    upsertSetting.run(req.user.id, 'insightText', text);
    res.json({ week, text });
  } catch (e) {
    if (e instanceof ProviderError) return res.status(501).json({ error: e.message });
    console.error(e);
    res.status(502).json({ error: 'Gagal menghubungi AI' });
  }
});

// ---------- Activity summary over a date range (Riwayat) ----------
app.post('/api/summary', async (req, res) => {
  const range = req.body && Number(req.body.range) === 30 ? 30 : 7;
  const since = new Date();
  since.setDate(since.getDate() - (range - 1));
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date >= ? ORDER BY date ASC').all(req.user.id, sinceStr);
  if (rows.length === 0) {
    return res.status(400).json({ error: 'Belum ada catatan di rentang ini. Coba pilih rentang yang lebih panjang.' });
  }
  const material = rows.map((r) => {
    const notes = parseNotes(r).map((n) => `- Pertanyaan: ${n.prompt}\n  Jawaban: ${String(n.text).slice(0, 600)}`).join('\n');
    return `${r.date} (mood: ${r.mood})\n${notes}`;
  }).join('\n\n').slice(0, 9000);
  const prompt = `Kamu merangkum jurnal harian seseorang dalam bahasa Indonesia yang natural dan hangat. Tugasmu: rangkum KEGIATAN sehari-hari dari catatan di bawah.\nAturan:\n1. Tulis satu baris untuk setiap tanggal yang punya catatan, diawali tanggal singkat (contoh: "Sen 28 Sep:"), lalu satu kalimat tentang apa yang dikerjakan atau dialami hari itu.\n2. Setelah itu tulis satu paragraf pendek (2-3 kalimat) diawali "Gambaran umum:" tentang pola kegiatan atau hal yang sering muncul.\n3. Hanya pakai hal yang benar-benar tertulis. Jangan mengarang, jangan mendiagnosis, jangan memberi saran medis.\n4. Tanpa markdown, tanpa tanda bintang, tanpa judul.\n\nCatatan:\n${material}`;
  try {
    const text = await generateText(prompt, { maxTokens: 500 });
    const at = Date.now();
    upsertSetting.run(req.user.id, 'summaryText', text);
    upsertSetting.run(req.user.id, 'summaryAt', String(at));
    upsertSetting.run(req.user.id, 'summaryRange', String(range));
    res.json({ text, at });
  } catch (e) {
    if (e instanceof ProviderError) return res.status(501).json({ error: e.message });
    console.error(e);
    res.status(502).json({ error: 'Gagal membuat rangkuman. Coba lagi sebentar lagi.' });
  }
});

// ---------- Same-day AI recap ("Harian" mode, Hari ini tab) ----------
// Distinct from /api/summary: this covers exactly one date and lives on that entry row
// (day_summary column), not in the settings table, so it never clashes with the 7/30-day summary.
app.post('/api/entries/:date/day-summary', async (req, res) => {
  const { date } = req.params;
  const row = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date = ?').get(req.user.id, date);
  if (!row) return res.status(400).json({ error: 'Belum ada catatan hari ini.' });
  const material = parseNotes(row).map((n) => `- ${n.prompt}\n  ${n.text}`).join('\n');
  const prompt = `Rangkum kegiatan HARI INI saja (bukan beberapa hari) dalam 2-4 kalimat yang mengalir seperti cerita singkat, bahasa Indonesia yang natural dan hangat. Hanya pakai hal yang benar-benar tertulis di catatan, jangan mengarang, jangan mendiagnosis, jangan memberi saran medis. Tanpa markdown, tanpa judul.\n\nCatatan hari ini:\n${material}`;
  try {
    const text = await generateText(prompt, { maxTokens: 300 });
    const at = Date.now();
    db.prepare('UPDATE entries SET day_summary = ? WHERE user_id = ? AND date = ?').run(JSON.stringify({ text, at }), req.user.id, date);
    res.json({ text, at });
  } catch (e) {
    if (e instanceof ProviderError) return res.status(501).json({ error: e.message });
    console.error(e);
    res.status(502).json({ error: 'Gagal membuat rangkuman. Coba lagi sebentar lagi.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Azzifa berjalan di http://localhost:${PORT}`);
});
