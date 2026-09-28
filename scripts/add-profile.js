// Usage: npm run add-profile -- <name> [--admin]
// Creates a profile, or resets an existing profile's password. Run on the host. It is also
// the recovery path if every admin is locked out: `--admin` makes the profile an admin.
// Profiles can otherwise be managed by an admin in Settings.
import readline from 'node:readline';
import { q } from '../server/db.js';
import { hashSecret } from '../server/auth.js';
import { profileDir } from '../server/config.js';

const name = process.argv[2];
const makeAdmin = process.argv.includes('--admin');
if (!name || !/^[A-Za-z0-9-]{2,32}$/.test(name)) {
  console.error('Give a profile name of 2-32 letters, digits or hyphens, e.g. npm run add-profile -- work');
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question(`Password for "${name}" (min 12 chars): `, (pw) => {
  rl.close();
  if (pw.length < 12) { console.error('Password must be at least 12 characters.'); process.exit(1); }
  const existing = q.profile.get(name); // matches ignoring case
  if (existing) {
    q.setPassword.run(hashSecret(pw), existing.name);
    if (makeAdmin) q.setRole.run('admin', existing.name);
  } else {
    // The first profile is always an admin, so someone can manage the rest.
    const role = makeAdmin || q.adminCount.get().n === 0 ? 'admin' : 'user';
    q.addProfile.run(name, hashSecret(pw), Date.now(), role, null);
  }
  const row = q.profile.get(name);
  console.log(`Profile "${row.name}" ${existing ? 'updated' : 'created'} (${row.role}). Its notes folder is ${profileDir(row.name)}`);
});
