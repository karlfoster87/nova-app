// What the two updaters share: the Agent SDK's (sdk.js, from npm) and Nova's own (app.js,
// from GitHub). Both are checked on one timer, installed only when an admin asks, staged and
// tested first, then applied by server/launcher.js between processes.
import { config } from '../core/config.js';

// One update at a time, of either kind.
export const updateLock = { by: null }; // null | 'sdk' | 'app'

// Numeric compare of x.y.z; a pre-release sorts below its release.
export function newer(a, b) {
  const [pa, pb] = [a, b].map((v) => v.split(/[.-]/));
  for (let i = 0; i < 3; i++) if (+pa[i] !== +pb[i]) return +pa[i] > +pb[i];
  return pa.length < pb.length;
}

// A check that runs every updates.checkHours (0 turns it off). The returned function
// (re)schedules it, first after firstDelay; it's re-armed after each run, so a changed
// interval applies from the next check.
export function checkTimer(check, enabled = () => true) {
  let timer = null;
  const schedule = (firstDelay) => {
    clearTimeout(timer);
    const hours = config.updates.checkHours;
    if (!(hours > 0) || !enabled()) return;
    timer = setTimeout(async () => { await check(); schedule(hours * 3600_000); }, firstDelay);
    timer.unref();
  };
  return schedule;
}
