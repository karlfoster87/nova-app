// The meta session: one idle Claude Code session (session.js) kept open to say which models
// are available, who is signed in, and how much of the plan is used. Every tab gets this as
// the 'meta' message, and again whenever it changes.
import { config, agentEnv } from '../core/config.js';
import { hub } from '../core/hub.js';
import { idleSession } from './session.js';

const state = {
  models: [],
  account: null,
  usage: null,        // last usage snapshot (plan windows + session cost)
  authError: null
};

let session = null;
let usageTimer = null;
let soonTimer = null;
const highUsage = { listeners: [], last: 0 }; // runner.js hands off long chats when the plan is nearly used

async function start() {
  stopSession();
  state.account = null; state.usage = null; // a restart follows a sign-in or sign-out: nothing old carries over
  session = idleSession({ cwd: config.paths.brainDir, settingSources: [], env: agentEnv() });
  const q = session.query;
  try {
    const [models, account] = await Promise.all([q.supportedModels(), q.accountInfo()]);
    state.models = models;
    state.account = account;
    state.authError = null;
  } catch (err) {
    state.authError = err.message;
  }
  await refreshUsage();
  broadcast();
  clearInterval(usageTimer);
  usageTimer = setInterval(refreshUsage, 2 * 60 * 1000);
  usageTimer.unref();
}

function stopSession() {
  session?.close();
  session = null;
}

async function refreshUsage() {
  if (!session) return;
  try {
    // Experimental in the SDK and may be renamed. If it disappears, the bars fall back
    // to rate_limit_event data from live chats.
    const fn = session.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== 'function') return;
    const u = await fn.call(session.query, { skipBehaviors: true });
    state.usage = {
      available: u.rate_limits_available,
      windows: u.rate_limits || {},
      subscription: u.subscription_type
    };
    broadcast();
    noteUsage(u.rate_limits);
  } catch { /* keep last snapshot */ }
}

// The fullest plan window, as a percentage: the 5-hour and weekly windows and any per-model ones.
// Extra usage is paid credit, not a limit, so it doesn't count.
function fullest(limits) {
  if (!limits) return 0;
  const windows = [...Object.entries(limits).filter(([k, w]) => k !== 'extra_usage' && w && !Array.isArray(w)).map(([, w]) => w),
    ...(Array.isArray(limits.model_scoped) ? limits.model_scoped : [])];
  return Math.max(0, ...windows.map((w) => Number(w.utilization) || 0));
}

// Past chats.handoffAtUsage, long chats write their handoffs (at most every ten minutes, as the
// usage call runs every two).
function noteUsage(limits) {
  const at = Number(config.chats.handoffAtUsage);
  if (!(at > 0) || fullest(limits) < at || Date.now() - highUsage.last < 10 * 60 * 1000) return;
  highUsage.last = Date.now();
  console.log(`Plan usage passed ${at}%, so long chats are writing their handoffs now.`);
  for (const fn of highUsage.listeners) { try { fn(); } catch (err) { console.error('High-usage handoff failed:', err); } }
}

function broadcast() { hub.toAll({ t: 'meta', meta: publicMeta() }); }

// What supportedModels() said about one model, or undefined before it has answered.
export const modelInfo = (value) => state.models.find((m) => m.value === value);

// True or false once accountInfo() has answered; null before that or if it failed, so a
// hiccup never blocks chats. A Console sign-in may have no email, only its key source.
export function signedIn() {
  const a = state.account;
  if (!a || state.authError) return null;
  return !!(a.email || (a.apiKeySource && a.apiKeySource !== 'none'));
}

export function publicMeta() {
  return {
    models: state.models.filter((m) => !config.models.hidden.includes(m.value)),
    allModels: state.models,
    hiddenModels: config.models.hidden,
    account: state.account ? {
      email: state.account.email || null,
      subscriptionType: state.account.subscriptionType || null,
      tokenSource: state.account.tokenSource || null,
      apiKeySource: state.account.apiKeySource || null
    } : null,
    signedIn: signedIn(),
    authError: state.authError,
    usage: state.usage,
    defaultEffort: config.models.defaultEffort,
    defaultModel: config.models.defaultModel,
    coldResume: config.chats.coldResume
  };
}

export const meta = {
  start,
  restart: start,
  stop() { clearInterval(usageTimer); clearTimeout(soonTimer); stopSession(); },
  broadcast,
  onHighUsage(fn) { highUsage.listeners.push(fn); },
  refreshUsageSoon() {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(refreshUsage, 3000);
  },
  // Live signal from chats. Its utilization units aren't documented, so it only
  // records warning status and triggers a fresh snapshot from the usage call.
  noteRateLimit(info) {
    if (!info?.rateLimitType) return;
    state.usage ??= { available: true, windows: {} };
    const w = state.usage.windows[info.rateLimitType] ||= { utilization: null, resets_at: null };
    w.status = info.status;
    broadcast();
    this.refreshUsageSoon();
  }
};
