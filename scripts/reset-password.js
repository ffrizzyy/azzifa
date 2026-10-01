// For whoever runs the server: gives an account a new temporary password when its owner has
// forgotten both the password and the answer to their personal question. Everyone signed in to that account is signed out.
//
//   npm run reset-password -- <nama-pengguna>
const crypto = require('crypto');
const db = require('../server/db');
const { setPassword } = require('../server/auth');

// The database is always closed before the process ends, and the script never calls
// process.exit(): exiting with the database still open makes its native module abort.
async function main() {
  const username = String(process.argv[2] || '').trim().toLowerCase();
  if (!username) return 'Pakai: npm run reset-password -- <nama-pengguna>';
  const user = db.prepare('SELECT id, name FROM users WHERE username = ?').get(username);
  if (!user) return `Tidak ada akun bernama "${username}".`;
  const temporary = crypto.randomBytes(9).toString('base64url');
  await setPassword(user.id, temporary);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  console.log(`Kata sandi sementara untuk @${username} (${user.name}): ${temporary}`);
  console.log('Minta pemilik akun masuk dengan kata sandi ini, lalu menggantinya dan mengatur ulang pertanyaan pribadinya di halaman Profil.');
  return null;
}

main()
  .catch((e) => e.message)
  .then((problem) => {
    db.close();
    if (problem) { console.error(problem); process.exitCode = 1; }
  });
