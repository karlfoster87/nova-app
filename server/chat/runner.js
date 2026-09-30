// One ChatRunner per open chat. Each wraps a long-lived Agent SDK query in
// streaming-input mode, so follow-up messages reuse the same Claude Code process.
import crypto from 'node:crypto';
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { config, agentEnv, profileDir, CLAUDE_DIR, OLD_CLAUDE_DIR } from './config.js';
import { q } from './db.js';
import { hub } from './hub.js';
import { meta, modelInfo } from './meta.js';
import { rememberableRules, isApproved, remember, sessionRules, folderPaths, folderFor, addFolder } from './permissions.js';
import { uploadsDir } from './uploads.js';
import fs from 'node:fs';

// Message types forwarded to the browser. Everything else stays server-side.
const FORWARD = new Set([
  'stream_event', 'assistant', 'user', 'result', 'system',
  'tool_progress', 'task_started', 'task_progress', 'task_notification', 'auth_status'
]);

// Permission modes offered in the UI. 'bypassPermissions' and 'dontAsk' are left out
// on purpose: one skips every check, the other silently denies.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan'];
const TASK_DONE = new Set(['completed', 'failed', 'killed']);

// Where a profile's Claude Code sessions run and what they load: the brain, the profile's notes,
// uploads and extra folders, and the brain's own .claude settings. Chats and the composer's
// command list (commands.js) share it, so the list shows what a chat can actually run.
export function sessionBase(profile) {
  const uploads = uploadsDir(profile); // attachments sent in this profile's chats
  fs.mkdirSync(uploads, { recursive: true });
  return {
    cwd: config.paths.brainDir,
    additionalDirectories: [profileDir(profile), uploads, ...folderPaths(profile)],
    settingSources: config.claude.settingSources,
    env: agentEnv()
  };
}

// Commands Claude Code says only make sense in its own terminal (exit, statusline and the like),
// from the latest chat that started. The composer leaves them out.
export const terminalCommands = new Set();

class InputQueue {
  constructor() { this.items = []; this.waiter = null; this.closed = false; }
  push(item) {
    if (this.waiter) { this.waiter({ value: item, done: false }); this.waiter = null; }
    else this.items.push(item);
  }
  close() { this.closed = true; this.waiter?.({ value: undefined, done: true }); }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiter = resolve; });
      }
    };
  }
}

class ChatRunner {
  constructor({ id, profile, model, effort, mode, isNew }) {
    Object.assign(this, { id, profile, model, effort, mode });
    this.state = 'idle';
    this.pending = new Map(); // reqId -> resolve(PermissionResult)
    this.pendingInfo = new Map(); // reqId -> payload, replayed to tabs that reconnect
    this.tasks = new Map(); // task_id -> { started, progress } for sub-agents still running, replayed on open
    this.lastActive = Date.now();
    this.input = new InputQueue();

    const ctx = profileDir(profile);
    const options = {
      ...sessionBase(profile),
      systemPrompt: {
        type: 'preset', preset: 'claude_code',
        append: `You are running in the Nova console under the "${profile}" profile. ` +
          `Notes specific to this profile live in ${ctx}; read them when context about the profile would help.`
      },
      includePartialMessages: true,
      canUseTool: (toolName, input, opts) => this.askPermission(toolName, input, opts)
    };
    if (model) options.model = model;
    if (effort) options.effort = effort;
    // Without a display mode the thinking text is left out and only a placeholder arrives.
    // 'summarized' streams a readable summary into the Thinking block. Only models that say
    // they support adaptive thinking get it (Haiku doesn't say so); the rest keep the SDK's
    // default. No model picked means the 'default' entry.
    if (config.models.showThinking && modelInfo(model || 'default')?.supportsAdaptiveThinking === true) {
      options.thinking = { type: 'adaptive', display: 'summarized' };
    }
    if (mode) options.permissionMode = mode;
    if (isNew) options.sessionId = id; else options.resume = id;

    this.query = query({ prompt: this.input, options });
    this.loop();
  }

  emit(payload) { hub.toProfile(this.profile, { chatId: this.id, ...payload }); }

  setState(state) {
    this.state = state;
    this.emit({ t: 'state', state });
  }

  async loop() {
    try {
      for await (const msg of this.query) {
        this.lastActive = Date.now();
        if (msg.type === 'rate_limit_event') { meta.noteRateLimit(msg.rate_limit_info); continue; }
        if (msg.type === 'system') this.trackSystem(msg);
        // Claude can start a turn on its own, e.g. when a background agent reports back.
        if (this.state === 'idle' && !msg.parent_tool_use_id && (msg.type === 'assistant' || msg.type === 'stream_event')) {
          this.setState('running');
        }
        if (FORWARD.has(msg.type)) this.emit({ t: 'sdk', msg });
        if (msg.type === 'result') {
          this.setState('idle');
          meta.refreshUsageSoon();
          if (this.stale) this.closeIfQuiet();
        }
      }
    } catch (err) {
      this.emit({ t: 'error', message: `The Claude process stopped: ${err.message}` });
    } finally {
      this.setState('closed');
      for (const resolve of this.pending.values()) resolve({ behavior: 'deny', message: 'Session closed.' });
      this.pending.clear();
      this.pendingInfo.clear();
      this.tasks.clear();
      if (registry.get(this.id) === this) registry.delete(this.id);
    }
  }

  // Keeps the running-task list (for tabs that open the chat later) and the
  // permission mode in step with what the Claude Code process reports.
  trackSystem(msg) {
    const s = msg.subtype;
    if (s === 'init' && Array.isArray(msg.terminal_slash_commands)) {
      terminalCommands.clear();
      for (const c of msg.terminal_slash_commands) terminalCommands.add(String(c));
    }
    if (s === 'task_started') this.tasks.set(msg.task_id, { started: msg });
    else if (s === 'task_progress' && this.tasks.has(msg.task_id)) this.tasks.get(msg.task_id).progress = msg;
    else if (s === 'task_notification' || (s === 'task_updated' && TASK_DONE.has(msg.patch?.status))) this.tasks.delete(msg.task_id);
    if ((s === 'init' || s === 'status') && msg.permissionMode && msg.permissionMode !== this.mode) {
      this.mode = msg.permissionMode;
      q.setChatMode.run(this.mode, this.id, this.profile);
      this.emit({ t: 'mode', mode: this.mode });
    }
  }

  async setMode(mode) {
    const previous = this.mode;
    this.mode = mode;
    try {
      await this.query.setPermissionMode(mode);
      q.setChatMode.run(mode, this.id, this.profile);
      this.emit({ t: 'mode', mode });
    } catch (err) {
      this.mode = previous;
      console.error(`setPermissionMode(${mode}) failed:`, err);
      this.emit({ t: 'mode', mode: previous });
      this.emit({ t: 'error', message: `Couldn't switch to that permission mode: ${err.message}` });
    }
  }

  // content: the text, or content blocks when files are attached (uploads.messageContent).
  send(content) {
    this.lastActive = Date.now();
    this.setState('running');
    q.touchChat.run(Date.now(), this.model, this.effort, this.id);
    this.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.id
    });
  }

  // Called by the SDK whenever a tool needs approval. AskUserQuestion is routed
  // through the same path; its answers go back as updatedInput.answers.
  askPermission(toolName, input, opts) {
    // Rules this profile chose to always allow: answer without asking, and add them to
    // the session so Claude Code stops asking for them in this chat.
    const rules = rememberableRules(toolName, opts.suggestions);
    if (rules && isApproved(this.profile, rules)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input, updatedPermissions: sessionRules(rules) });
    }
    const reqId = crypto.randomUUID();
    const payload = {
      t: 'permission', reqId, toolName, input,
      title: opts.title || null,
      blockedPath: opts.blockedPath || null,
      folder: folderFor(opts.blockedPath), // offered as "Add this folder"; the answer uses this, never a path from the browser
      canRemember: Boolean(opts.suggestions?.length),
      alwaysRules: rules ? rules.map((r) => (r.rule ? `${r.tool}(${r.rule})` : r.tool)) : null
    };
    this.pendingInfo.set(reqId, payload);
    this.emit(payload);
    return new Promise((resolve) => {
      this.pending.set(reqId, (result) => {
        if (result.behavior === 'allow_session') {
          // Kept to this session: Claude Code's suggestions can name a settings file, and
          // that file is shared by every profile.
          const updatedPermissions = opts.suggestions?.map((s) => ({ ...s, destination: 'session' }));
          resolve({ behavior: 'allow', updatedInput: input, updatedPermissions });
        } else if (result.behavior === 'always' && rules) {
          remember(this.profile, rules);
          resolve({ behavior: 'allow', updatedInput: input, updatedPermissions: sessionRules(rules) });
        } else if (result.behavior === 'add_folder' && result.dir) {
          resolve({ behavior: 'allow', updatedInput: input,
            updatedPermissions: [{ type: 'addDirectories', directories: [result.dir], destination: 'session' }] });
        } else if (result.behavior === 'answer') {
          resolve({ behavior: 'allow', updatedInput: { ...input, answers: result.answers } });
        } else if (result.behavior === 'allow') {
          resolve({ behavior: 'allow', updatedInput: input });
        } else {
          resolve({ behavior: 'deny', message: result.message || 'The user declined this action.' });
        }
      });
      opts.signal?.addEventListener('abort', () => {
        this.pending.delete(reqId);
        this.pendingInfo.delete(reqId);
        this.emit({ t: 'permission_cancelled', reqId });
      });
    });
  }

  answer(reqId, result) {
    const resolve = this.pending.get(reqId);
    if (!resolve) return;
    if (result.behavior === 'add_folder') {
      // Store the folder the server worked out for this request. If it can't be used,
      // say why and leave the prompt open for another choice.
      const folder = this.pendingInfo.get(reqId)?.folder;
      try {
        if (!folder) throw new Error('There\'s no folder to add for this request.');
        result = { behavior: 'add_folder', dir: addFolder(this.profile, folder) };
      } catch (err) {
        this.emit({ t: 'error', message: `Couldn't add that folder: ${err.message}` });
        return;
      }
      refreshRunners(this.profile, this);
    }
    this.pending.delete(reqId);
    this.pendingInfo.delete(reqId);
    resolve(result);
    this.emit({ t: 'permission_resolved', reqId });
  }

  pendingRequests() { return [...this.pendingInfo.values()].map((p) => ({ chatId: this.id, ...p })); }

  // Task messages for sub-agents still running, so a freshly opened tab can show them.
  runningTasks() {
    return [...this.tasks.values()].flatMap(({ started, progress }) =>
      [started, progress].filter(Boolean).map((msg) => ({ t: 'sdk', chatId: this.id, msg })));
  }

  async interrupt() { try { await this.query.interrupt(); } catch {} }

  // Closes the process if nothing would be lost; the next send resumes the session.
  closeIfQuiet() {
    if (this.state === 'idle' && !this.pending.size && !this.tasks.size) this.close();
    else this.stale = true;
  }

  close() { this.input.close(); try { this.query.close(); } catch {} }
}

const registry = new Map();

// Every chat lookup goes through here so a profile can never reach another profile's chat.
export function ownedChat(profile, id) {
  const row = q.chat.get(id);
  return row && row.profile === profile ? row : null;
}

export function createChat(profile, { model, effort, categoryId = null }) {
  const id = crypto.randomUUID();
  q.addChat.run(id, profile, null, model || null, effort || null, Date.now(), Date.now(), categoryId);
  return id;
}

export function runnerFor(profile, id, { model, effort, mode }) {
  const row = ownedChat(profile, id);
  if (!row) return null;
  let runner = registry.get(id);
  // Model or effort changed: restart the process and resume the same session.
  if (runner && (runner.model !== model || runner.effort !== effort) && runner.state !== 'running') {
    runner.close();
    registry.delete(id);
    runner = null;
  }
  if (!runner) {
    const hasHistory = row.title !== null;
    runner = new ChatRunner({ id, profile, model, effort, mode: mode || row.permission_mode || undefined, isNew: !hasHistory });
    registry.set(id, runner);
  }
  return runner;
}

// Chats that would lose work if their process stopped now.
export function busyRunners() {
  return [...registry.values()].filter((r) => r.state === 'running' || r.pending.size || r.tasks.size);
}

export function closeAllRunners() { for (const r of registry.values()) r.close(); }

export function runnersOf(profile) { return [...registry.values()].filter((r) => r.profile === profile); }

// A profile's folders or approvals changed. Open chats pick that up at process start, so
// restart each one now if it's idle, or as soon as it finishes what it's doing.
export function refreshRunners(profile, except = null) {
  for (const r of runnersOf(profile)) if (r !== except) r.closeIfQuiet();
}

// The same for every profile, after a global setting that applies at process start changed.
export function refreshAllRunners() {
  for (const r of registry.values()) r.closeIfQuiet();
}

export function existingRunner(profile, id) {
  const r = registry.get(id);
  return r && r.profile === profile ? r : null;
}

export async function history(profile, id) {
  if (!ownedChat(profile, id)) return null;
  try { return await getSessionMessages(id, { dir: config.paths.brainDir }); }
  catch { return []; }
}

// Transcripts written before Nova had its own Claude folder are copied in, so
// older chats keep their history. Only Nova's chats, never over a newer copy; the originals stay.
export function adoptTranscripts() {
  const from = path.join(OLD_CLAUDE_DIR, 'projects'), to = path.join(CLAUDE_DIR, 'projects');
  let folders;
  try { folders = fs.readdirSync(from, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
  const ids = new Set(q.allChatIds.all().map((r) => r.id));
  let copied = 0;
  for (const { name: folder } of folders) {
    let files;
    try { files = fs.readdirSync(path.join(from, folder)); } catch { continue; }
    for (const file of files) {
      const id = file.endsWith('.jsonl') && file.slice(0, -6);
      if (!id || !ids.has(id) || fs.existsSync(path.join(to, folder, file))) continue;
      try {
        fs.mkdirSync(path.join(to, folder), { recursive: true });
        const side = path.join(from, folder, id); // sub-agent transcripts and tool results
        if (fs.existsSync(side)) fs.cpSync(side, path.join(to, folder, id), { recursive: true, force: false });
        fs.copyFileSync(path.join(from, folder, file), path.join(to, folder, file)); // last: its presence marks the chat as done
        copied++;
      } catch (err) { console.error(`Couldn't copy the transcript of chat ${id}:`, err.message); }
    }
  }
  if (copied) console.log(`Copied ${copied} chat transcript${copied === 1 ? '' : 's'} into ${to}. The originals are still in ${from}.`);
}

export function stateOf(id) { return registry.get(id)?.state || 'closed'; }

// Close processes that have sat idle, so concurrent chats don't pile up.
setInterval(() => {
  const cutoff = Date.now() - config.chats.idleMinutes * 60 * 1000;
  for (const r of registry.values()) {
    if (r.state === 'idle' && r.lastActive < cutoff && r.pending.size === 0 && r.tasks.size === 0) r.close();
  }
}, 60 * 1000).unref();
