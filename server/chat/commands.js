// Slash commands for the composer's suggestions: the brain's own skills and commands (its
// .claude folder, plugins) and Claude Code's built-in ones, as a chat in this profile would see
// them. An open chat is asked directly, since it knows skills it found while working. Otherwise
// a short-lived Claude Code session with the chat's settings is asked and closed again. It never
// receives a prompt, so it uses none of the plan's limits. Lists are kept briefly per profile.
import { sessionBase, existingRunner, terminalCommands } from './runner.js';
import { idleSession } from '../claude/session.js';

const TTL = 60 * 1000;
const cache = new Map();   // profile -> { at, list }
const loading = new Map(); // profile -> Promise, so several requests share one session

// Built-in commands that would work against Nova rather than for it. /clear starts a new
// Claude Code session, which would cut the chat off from its own history in Nova; New chat
// does the same job safely.
const HIDDEN = new Set(['clear']);

function shape(commands) {
  return commands
    .filter((c) => c?.name && !c.name.startsWith('_') && !HIDDEN.has(c.name) && !terminalCommands.has(c.name)
      && !/^\(removed\)/i.test(c.description || ''))
    .map((c) => ({
      name: c.name,
      // Claude Code adds where a command came from, e.g. "(project)"; the menu groups by that instead.
      description: String(c.description || '').replace(/\s*\((project|local)\)\s*$/i, ''),
      argumentHint: c.argumentHint || '',
      aliases: Array.isArray(c.aliases) ? c.aliases : [],
      source: c.builtin ? 'claude' : 'brain'
    }))
    .sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'brain' ? -1 : 1));
}

async function fromSession(profile) {
  const session = idleSession(sessionBase(profile));
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Claude Code didn\'t list its commands in time.')), 30_000).unref());
  try { return await Promise.race([session.query.supportedCommands(), timeout]); }
  finally { session.close(); }
}

// The commands for this profile, from its open chat when there is one.
export async function commandsFor(profile, chatId) {
  const runner = chatId ? existingRunner(profile, chatId) : null;
  if (runner && runner.state !== 'closed') {
    try { return shape(await runner.query.supportedCommands()); } catch { /* ask a session instead */ }
  }
  const hit = cache.get(profile);
  if (hit && Date.now() - hit.at < TTL) return hit.list;
  if (!loading.has(profile)) {
    loading.set(profile, fromSession(profile)
      .then((commands) => { const list = shape(commands); cache.set(profile, { at: Date.now(), list }); return list; })
      .finally(() => loading.delete(profile)));
  }
  return loading.get(profile);
}
