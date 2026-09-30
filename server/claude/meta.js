// A small idle Agent SDK session that never receives a prompt. It exists to answer
// control requests: which models are available, who is signed in, and plan usage.
// Nothing here sends a message to Claude, so it does not use any of your limits.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config, agentEnv } from './config.js';
import { hub } from './hub.js';

const state = {
  models: [],
  account: null,
  usage: null,        // last usage snapshot (plan windows + session cost)
  authError: null,
  sdkVersion: null
};

let session = null;
let usageTimer = null;
let soonTimer = null;

function neverEndingPrompt() {
  let stop;
  const done = new Promise((r) => { stop = r; });
  const iterable = { async *[Symbol.asyncIterator]() { await done; } };
  return { iterable, stop };
}

async function start() {
  stopSession();
  state.account = null; state.usage = null; // a restart follows a sign-in or sign-out: nothing old carries over
  const prompt = neverEndingPrompt();
  const q = query({
    prompt: prompt.iterable,
    options: { cwd: config.paths.brainDir, settingSources: [], env: agentEnv() }
  });
  session = { q, stop: prompt.stop };
  // Drain messages so the process doesn't stall on backpressure.
  (async () => { try { for await (const _ of q) {} } catch {} })();

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
  if (!session) return;
  session.stop();
  try { session.q.close(); } catch {}
  session = null;
}

async function refreshUsage() {
  if (!session) return;
  try {
    // Experimental in the SDK and may be renamed. If it disappears, the bars fall back
    // to rate_limit_event data from live chats.
    const fn = session.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== 'function') return;
    const u = await fn.call(session.q, { skipBehaviors: true });
    state.usage = {
      available: u.rate_limits_available,
      windows: u.rate_limits || {},
      subscription: u.subscription_type
    };
    broadcast();
  } catch { /* keep last snapshot */ }
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
    defaultModel: config.models.defaultModel
  };
}

export const meta = {
  start,
  restart: start,
  stop() { clearInterval(usageTimer); clearTimeout(soonTimer); stopSession(); },
  broadcast,
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
