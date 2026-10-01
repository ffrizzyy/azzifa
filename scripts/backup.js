// Copies the live database into one consistent file. Safe to run while the app is in use:
// SQLite's online backup takes a snapshot instead of copying a file that is being written to.
//
//   npm run backup                 -> <data dir>/backups/azzifa-<date>-<time>.sqlite
//   npm run backup -- /some/file   -> that file
const fs = require('fs');
const path = require('path');
const db = require('../server/db');

const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const dest = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(path.dirname(db.name), 'backups', `azzifa-${stamp}.sqlite`);

fs.mkdirSync(path.dirname(dest), { recursive: true });
// The database is closed before the process ends in both outcomes, and process.exit() is never
// called: exiting with the database still open makes its native module abort.
db.backup(dest)
  .then(() => console.log(`Cadangan tersimpan: ${dest} (${Math.round(fs.statSync(dest).size / 1024)} KB)`))
  .catch((e) => { console.error('Cadangan gagal:', e.message); process.exitCode = 1; })
  .finally(() => db.close());
