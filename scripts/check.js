// Syntax-checks every server, browser and script file. Run before committing.
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let failed = false;
for (const dir of ['server', 'public', 'scripts']) {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    try { execFileSync(process.execPath, ['--check', `${dir}/${f}`], { stdio: 'pipe' }); }
    catch (err) { failed = true; console.error(`${dir}/${f}\n${err.stderr}`); }
  }
}
if (failed) process.exit(1);
console.log('All files pass the syntax check.');
