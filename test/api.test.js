// End-to-end tests: starts the real server against a throwaway database and talks to it over HTTP.
// Run with `npm test`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { utcDay, shiftDay } = require('../server/day');

const PORT = 3491;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azzifa-test-'));
let server;

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    // An empty key keeps the AI "unconfigured" even if the developer's own .env has one.
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '', ALLOW_SIGNUP: 'true', SIGNUPS_PER_HOUR: '100' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(async () => {
  server.kill();
  await new Promise((r) => server.once('exit', r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// One browser: keeps its session cookie and reports a local date, as the page does.
function client(localDate = utcDay()) {
  let cookie = '';
  const call = async (method, url, body, raw) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'X-Local-Date': call.day, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    return { status: res.status, data, headers: res.headers };
  };
  call.day = localDate;
  return call;
}
const note = (text, extra = {}) => ({ prompt: 'Apa kabar hari ini?', text, at: Date.now(), ...extra });
const write = (c, date, text = 'catatan uji') => c('PUT', `/api/entries/${date}`, { mood: 'tenang', notes: [note(text)] });
const register = async (username, localDate) => {
  const c = client(localDate);
  const res = await c('POST', '/api/auth/register', { username, name: username[0].toUpperCase() + username.slice(1), password: `rahasia-${username}-1` });
  assert.equal(res.status, 200);
  return c;
};

const today = utcDay();
const yesterday = shiftDay(today, -1);

test('nothing under /api is readable without signing in', async () => {
  const anon = client();
  for (const url of ['/api/me', '/api/entries', '/api/settings', '/api/circles', '/api/export.json', '/api/export.txt']) {
    assert.equal((await anon('GET', url)).status, 401, url);
  }
  const cfg = (await anon('GET', '/api/auth/config')).data;
  assert.deepEqual(cfg, { signup: true, firstAccount: true });
});

test('responses carry the security headers', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('registration validates, and accounts cannot share a username', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/register', { username: 'ana', password: 'short' })).status, 400);
  assert.equal((await c('POST', '/api/auth/register', { username: 'a b', password: 'long-enough-1' })).status, 400);
  const ok = await c('POST', '/api/auth/register', { username: 'Ana', name: 'Ana', password: 'rahasia-ana-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.username, 'ana');
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal((await client()('POST', '/api/auth/register', { username: 'ana', password: 'another-pass-1' })).status, 409);
});

test('login, logout and lockout', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: 'ana', password: 'wrong-pass-1' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { username: 'ANA', password: 'rahasia-ana-1' })).status, 200);
  assert.equal((await c('GET', '/api/me')).data.username, 'ana');
  await c('POST', '/api/auth/logout');
  assert.equal((await c('GET', '/api/me')).status, 401);

  await register('kunci');
  const guesser = client();
  let last;
  for (let i = 0; i < 9; i++) last = await guesser('POST', '/api/auth/login', { username: 'kunci', password: `guess-${i}-xx` });
  assert.equal(last.status, 429);
});

test('entries are validated and cleaned before they are stored', async () => {
  const c = await register('budi');
  assert.equal((await c('PUT', '/api/entries/not-a-date', { notes: [note('x')] })).status, 400);
  assert.equal((await c('PUT', '/api/entries/2026-02-31', { notes: [note('x')] })).status, 400);
  assert.equal((await c('PUT', `/api/entries/${today}`, { notes: [note('   ')] })).status, 400);
  assert.equal((await c('PUT', `/api/entries/${today}`, {})).status, 400);

  const res = await c('PUT', `/api/entries/${today}`, {
    mood: '<script>', notes: [note('halo #kerja', { fav: true, evil: '<img onerror=x>' }), { text: 42 }], daySummary: { text: 'ringkas', at: 1, extra: true },
  });
  assert.equal(res.status, 200);
  const [entry] = (await c('GET', '/api/entries')).data;
  assert.equal(entry.mood, 'biasa');
  assert.equal(entry.notes.length, 1);
  assert.deepEqual(Object.keys(entry.notes[0]).sort(), ['at', 'fav', 'prompt', 'text']);
  assert.deepEqual(entry.daySummary, { text: 'ringkas', at: 1 });
  assert.equal(entry.text, 'halo #kerja');
});

test('one account cannot see another account\'s journal', async () => {
  const ana = client();
  await ana('POST', '/api/auth/login', { username: 'ana', password: 'rahasia-ana-1' });
  await write(ana, today, 'rahasia ana');
  const citra = await register('citra');
  assert.equal((await citra('GET', '/api/entries')).data.length, 0);
  assert.equal((await citra('GET', '/api/export.json')).data.entries.length, 0);
  assert.equal((await citra('DELETE', `/api/entries/${today}`)).status, 200);
  assert.equal((await ana('GET', '/api/entries')).data.length, 1, 'deleting your own empty day must not touch someone else\'s');
});

test('the server takes "today" from the caller, within a day of its own clock', async () => {
  const c = await register('dewi', yesterday);
  const name = (res) => res.headers.get('content-disposition');
  await write(c, yesterday);
  assert.match(name(await c('GET', '/api/export.json')), new RegExp(yesterday));
  c.day = '1999-01-01'; // nonsense: ignored, falls back to the server's UTC date
  assert.match(name(await c('GET', '/api/export.json')), new RegExp(today));
});

test('backup round-trips, and restore skips what it cannot read', async () => {
  const c = await register('eka');
  await write(c, yesterday, 'kemarin');
  await c('PUT', `/api/entries/${today}`, { mood: 'senang', notes: [note('hari ini', { fav: true })] });
  const backup = (await c('GET', '/api/export.json')).data;
  assert.equal(backup.entries.length, 2);
  await c('DELETE', `/api/entries/${yesterday}`);
  const restored = await c('POST', '/api/import', { entries: [...backup.entries, { date: 'nope', text: 'x' }, { date: '2020-01-01', notes: [{ text: ' ' }] }, null] });
  assert.deepEqual(restored.data, { ok: true, imported: 2, skipped: 3 });
  const after = (await c('GET', '/api/entries')).data;
  assert.equal(after.length, 2);
  assert.equal(after.find((e) => e.date === today).notes[0].fav, true);
  assert.equal((await c('POST', '/api/import', { entries: [] })).status, 400);
});

test('settings only accept the keys the user owns', async () => {
  const c = await register('fajar');
  const res = await c('PUT', '/api/settings', { reminderTime: '21:30', dayMode: 'daily', insightText: 'injected', summaryText: 'injected' });
  assert.equal(res.data.reminderTime, '21:30');
  assert.equal(res.data.dayMode, 'daily');
  assert.equal(res.data.insightText, null);
  assert.equal(res.data.summaryText, null);
  assert.equal((await c('PUT', '/api/settings', { reminderTime: 'whenever' })).data.reminderTime, '21:30');
});

test('without a provider key the AI routes say so kindly, and settings report it', async () => {
  const c = await register('gita');
  assert.deepEqual((await c('GET', '/api/settings')).data.ai, { configured: false, label: 'Claude' });
  for (let i = 0; i < 3; i++) await write(c, shiftDay(today, -i), `catatan ${i}`);
  for (const [url, body] of [['/api/insight'], ['/api/summary', { range: 7 }], [`/api/entries/${today}/day-summary`]]) {
    const res = await c('POST', url, body);
    assert.equal(res.status, 501, url);
    assert.doesNotMatch(res.data.error, /API_KEY|\.env/, 'the technical reason stays in the server log');
  }
});

test('errors come back as JSON in the app\'s own voice', async () => {
  const c = await register('hadi');
  const missing = await c('GET', '/api/no-such-thing');
  assert.equal(missing.status, 404);
  assert.equal(typeof missing.data.error, 'string');
  const broken = await c('PUT', `/api/entries/${today}`, null, '{"notes": [');
  assert.equal(broken.status, 400);
  assert.equal(typeof broken.data.error, 'string');
});

test('a circle\'s streak counts the days every member wrote', async () => {
  // Both join "yesterday" (their local date), so yesterday and today are days the circle covers.
  const indah = await register('indah', yesterday);
  const joko = await register('joko', yesterday);
  const made = (await indah('POST', '/api/circles', { name: 'Tim Pagi' })).data;
  assert.equal(made.length, 1);
  assert.match(made[0].code, /^[A-Z2-9]{6}$/);
  assert.equal(made[0].streak, 0, 'one member is not a streak');
  assert.equal((await joko('POST', '/api/circles/join', { code: 'ZZZZZZ' })).status, 404);
  assert.equal((await joko('POST', '/api/circles/join', { code: made[0].code.toLowerCase() })).data[0].members.length, 2);
  assert.equal((await joko('POST', '/api/circles/join', { code: made[0].code })).status, 409);

  await write(indah, yesterday);
  await write(joko, yesterday);
  indah.day = today; joko.day = today;
  let view = (await indah('GET', '/api/circles')).data[0];
  assert.equal(view.streak, 1, 'yesterday is complete; an unfinished today does not break it');
  assert.equal(view.todayComplete, false);
  assert.deepEqual(Object.keys(view.members[0]).sort(), ['me', 'name', 'wroteToday'], 'only name and wrote-today are shared');

  await write(indah, today);
  view = (await joko('GET', '/api/circles')).data[0];
  assert.equal(view.streak, 1);
  assert.equal(view.members.find((m) => m.me).wroteToday, false);
  await write(joko, today);
  view = (await joko('GET', '/api/circles')).data[0];
  assert.equal(view.streak, 2);
  assert.equal(view.todayComplete, true);

  // A newcomer who has not written makes today incomplete, but cannot undo the days before they joined.
  const lala = await register('lala');
  await lala('POST', '/api/circles/join', { code: made[0].code });
  view = (await indah('GET', '/api/circles')).data[0];
  assert.equal(view.todayComplete, false);
  assert.equal(view.streak, 1);
  await write(lala, today);
  assert.equal((await indah('GET', '/api/circles')).data[0].streak, 2);

  assert.equal((await lala('DELETE', `/api/circles/${view.id}/membership`)).data.length, 0);
  assert.equal((await indah('GET', '/api/circles')).data[0].members.length, 2);
});
