// Usage: npm run claude-login [-- --console | -- status | -- logout]
// Signs Nova in to Claude from a terminal on the host, for when Settings can't
// be reached. Runs the bundled Claude Code against Nova's own Claude folder. Run it as the
// OS user Nova runs as, with the same NOVA_DATA_DIR, then restart Nova.
import { spawnSync } from 'node:child_process';
import { agentEnv, CLAUDE_DIR } from '../server/config.js';
import { claudeBinary } from '../server/signin.js';

const ARGS = {
  '': ['auth', 'login', '--claudeai'], '--console': ['auth', 'login', '--console'],
  status: ['auth', 'status', '--text'], logout: ['auth', 'logout']
};
const arg = process.argv[2] || '';
if (!ARGS[arg]) {
  console.log('Usage: npm run claude-login [-- --console | -- status | -- logout]');
  process.exit(1);
}
console.log(`Nova's Claude folder: ${CLAUDE_DIR}\n`);
const r = spawnSync(claudeBinary(), ARGS[arg], { stdio: 'inherit', env: agentEnv() });
if (arg !== 'status' && r.status === 0) console.log('\nDone. Restart Nova so it picks up the change.');
process.exit(r.status ?? 1);
