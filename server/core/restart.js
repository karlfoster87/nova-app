// Restarting Nova from inside. server/launcher.js starts this process with NOVA_SUPERVISED=1
// and starts it again when it exits with RESTART_CODE; between the two it installs any staged
// update. Run bare (node server/index.js), there's nothing to restart it, so callers check
// SUPERVISED first. Anything that restarts must also refuse while chats are busy.
import crypto from 'node:crypto';
import { hub } from './hub.js';

export const SUPERVISED = process.env.NOVA_SUPERVISED === '1';
export const RESTART_CODE = 75; // must match server/launcher.js
// Random per process: the restart screen polls /api/health until it changes.
export const BOOT_ID = crypto.randomUUID();

// What to stop before exiting, in the order registered (index.js adds chats, the meta
// session, sockets and the HTTP server).
const stoppers = [];
export const beforeRestart = (fn) => stoppers.push(fn);

// Tells every tab why Nova is restarting, then exits once the HTTP response has left.
export function restart(reason) {
  hub.toAll({ t: 'restarting', reason, boot: BOOT_ID });
  setTimeout(() => {
    for (const stop of stoppers) stop();
    process.exit(RESTART_CODE);
  }, 300);
}
