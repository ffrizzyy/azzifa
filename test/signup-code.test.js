// A server started with SIGNUP_CODE only lets people with the code create an account.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3492;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azzifa-code-'));
let server;

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, SIGNUP_CODE: 'teman-dekat', TRUST_PROXY: '1', ANTHROPIC_API_KEY: '' },
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

const post = (url, body, headers = {}) => fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the sign-in screen is told a code is needed', async () => {
  const cfg = await (await fetch(`${BASE}/api/auth/config`)).json();
  assert.equal(cfg.needsCode, true);
});

test('registration needs the right code, even for the first account', async () => {
  const account = { username: 'rina', name: 'Rina', password: 'rahasia-rina-1' };
  assert.equal((await post('/api/auth/register', account)).status, 403);
  assert.equal((await post('/api/auth/register', { ...account, code: 'salah' })).status, 403);
  assert.equal((await post('/api/auth/register', { ...account, code: 'teman-dekat' })).status, 200);
});

test('behind a proxy, HTTPS visitors get a Secure cookie and HSTS', async () => {
  const res = await post('/api/auth/login', { username: 'rina', password: 'rahasia-rina-1' }, { 'X-Forwarded-Proto': 'https' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /; Secure/);
  assert.match(res.headers.get('strict-transport-security'), /max-age=31536000/);
  const plain = await fetch(`${BASE}/healthz`);
  assert.equal(plain.headers.get('strict-transport-security'), null, 'no HSTS over plain HTTP');
});

test('guessing the code is cut off', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await post('/api/auth/register', { username: `tamu${i}`, password: 'rahasia-tamu-1', code: `tebak-${i}` }, { 'X-Forwarded-For': '203.0.113.9' });
  assert.equal(last.status, 429);
  // A different visitor is not caught in someone else's lockout.
  assert.equal((await post('/api/auth/register', { username: 'sari', password: 'rahasia-sari-1', code: 'teman-dekat' }, { 'X-Forwarded-For': '203.0.113.10' })).status, 200);
});
