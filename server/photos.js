// Pictures attached to notes. A picture is uploaded first (unattached), then a note saved with
// its id claims it. Only its owner can ever fetch it, and it is removed when the note that
// holds it is edited to drop it or deleted.
const crypto = require('crypto');
const express = require('express');
const db = require('./db');

const MAX_BYTES = 4 * 1024 * 1024; // the page shrinks pictures to a few hundred KB before sending
const MAX_PER_NOTE = 4;
const MAX_PER_USER = Number(process.env.PHOTO_LIMIT) || 2000;
const UNATTACHED_TTL_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[a-f0-9]{32}$/;

// The type comes from the file's own first bytes, never from what the upload claims to be.
// Anything that is not one of these three is refused — in particular SVG, which can carry script.
function sniffMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const insert = db.prepare('INSERT INTO photos (id, user_id, mime, data, attached, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const ownerOf = db.prepare('SELECT user_id FROM photos WHERE id = ?');

/** Stores one picture for a user and returns its id, or null when the bytes are not an image we accept. */
function store(userId, buf, { attached = false, id = crypto.randomBytes(16).toString('hex') } = {}) {
  const mime = Buffer.isBuffer(buf) && buf.length <= MAX_BYTES ? sniffMime(buf) : null;
  if (!mime) return null;
  insert.run(id, userId, mime, buf, attached ? 1 : 0, Date.now());
  return id;
}

/** The ids from `ids` that are real pictures belonging to this user, capped at what one note may hold. */
function owned(userId, ids) {
  if (!Array.isArray(ids)) return [];
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && ID_RE.test(id)))];
  return unique.filter((id) => ownerOf.get(id)?.user_id === userId).slice(0, MAX_PER_NOTE);
}

/** After a day is saved or deleted: drop the pictures it no longer uses, claim the ones it now does. */
function sync(userId, before, after) {
  const keep = new Set(after);
  const drop = db.prepare('DELETE FROM photos WHERE id = ? AND user_id = ?');
  const claim = db.prepare('UPDATE photos SET attached = 1 WHERE id = ? AND user_id = ?');
  before.filter((id) => !keep.has(id)).forEach((id) => drop.run(id, userId));
  after.forEach((id) => claim.run(id, userId));
}

/** Every picture in `ids` that belongs to this user, base64-encoded, for a backup file. */
function exportFor(userId, ids) {
  const get = db.prepare('SELECT id, mime, data FROM photos WHERE id = ? AND user_id = ?');
  return ids.map((id) => get.get(id, userId)).filter(Boolean).map((p) => ({ id: p.id, mime: p.mime, data: p.data.toString('base64') }));
}

/** Puts a backup's pictures back. Ones this user already has are left alone; ids taken by someone else are skipped. */
function restoreFor(userId, list) {
  if (!Array.isArray(list)) return 0;
  let restored = 0;
  list.forEach((p) => {
    if (!p || typeof p.id !== 'string' || !ID_RE.test(p.id) || typeof p.data !== 'string') return;
    if (ownerOf.get(p.id)) return;
    if (store(userId, Buffer.from(p.data, 'base64'), { attached: true, id: p.id })) restored += 1;
  });
  return restored;
}

const router = express.Router();

router.post('/', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_BYTES }), (req, res) => {
  // An upload that was never saved into a note is forgotten after a day.
  db.prepare('DELETE FROM photos WHERE user_id = ? AND attached = 0 AND created_at < ?').run(req.user.id, Date.now() - UNATTACHED_TTL_MS);
  if (db.prepare('SELECT COUNT(*) AS n FROM photos WHERE user_id = ?').get(req.user.id).n >= MAX_PER_USER) {
    return res.status(400).json({ error: 'Album jurnalmu sudah penuh. Hapus beberapa foto lama dulu, ya.' });
  }
  const id = Buffer.isBuffer(req.body) ? store(req.user.id, req.body) : null;
  if (!id) return res.status(415).json({ error: 'Gambarnya belum bisa dibaca. Coba foto lain atau format JPG/PNG, ya.' });
  res.json({ id });
});

router.get('/:id', (req, res) => {
  const photo = ID_RE.test(req.params.id)
    ? db.prepare('SELECT mime, data FROM photos WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id)
    : null;
  if (!photo) return res.status(404).json({ error: 'Fotonya tidak ditemukan.' });
  // An id never changes its picture, so the browser can keep it — but only this browser.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.type(photo.mime).send(photo.data);
});

module.exports = { router, owned, sync, exportFor, restoreFor, MAX_BYTES };
