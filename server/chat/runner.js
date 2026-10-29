// One ChatRunner per open chat. Each wraps a long-lived Agent SDK query in streaming-input
// mode, so follow-up messages reuse the same Claude Code process. The registry below tracks
// every runner; chats.js decides when to start one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config, agentEnv, profileDir } from '../core/config.js';
import { q } from '../core/db.js';
import { hub } from '../core/hub.js';
import { UserError } from '../core/errors.js';
import { meta, modelInfo } from '../claude/meta.js';
import { rememberableRules, isApproved, remember, sessionRules, folderPaths, folderFor, addFolder } from './permissions.js';
import { uploadsDir } from './uploads.js';
import { novaServer, READ_TOOLS, describeCall } from './tools.js';
import { HANDOFF_REQUEST, warmHandoff, usageTokens, bigChat, sessionOf, cutFor } from './handoff.js';
import { can } from '../accounts/access.js';

// Message types forwarded to the browser. Everything else stays server-side.
const FORWARD = new Set([
  'stream_event', 'assistant', 'user', 'result', 'system',
  'tool_progress', 'task_started', 'task_progress', 'task_notification', 'auth_status'
]);

// Permission modes offered in the UI. 'bypassPermissions' and 'dontAsk' are left out
// on purpose: one skips every check, the other silently denies.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const TASK_DONE = new Set(['completed', 'failed', 'killed']);

// Where a profile's Claude Code sessions run and what they load: the brain, the profile's notes,
// uploads and extra folders, and the brain's own .claude settings. Chats and the composer's
// command list (commands.js) share it, so the list shows what a chat can actually run.
export function sessionBase(profile) {
  const uploads = uploadsDir(profile); // attachments sent in this profile's chats
  fs.mkdirSync(uploads, { recursive: true });
  return {
    cwd: config.paths.brainDir,
    additionalDirectories: [profileDir(profile), uploads, ...folderPaths(profile), ...(buildsApps(profile) ? [appsFolder()] : [])],
    settingSources: config.claude.settingSources,
    env: agentEnv()
  };
}

// Profiles with Apps edit access can have Nova build apps: the apps folder joins the chat's
// folders, and the system prompt says how an app is laid out and how to link to one.
const buildsApps = (profile) => can(profile, 'apps', 'edit');
const appsFolder = () => { fs.mkdirSync(config.paths.appsDir, { recursive: true }); return config.paths.appsDir; };
// Only a pointer: the full guide is the apps_guide tool (tools.js), so the many chats that never
// touch an app don't carry it in every session's prompt.
const appsNote = () => ` You can build web apps for the user in the Nova apps folder, ${appsFolder()}. Before creating or ` +
  'changing an app, or linking to one, call the apps_guide tool for how Nova apps work.';

// Very long Bash or Read output fills the context for the rest of the chat, and every later turn
// pays to read it again. Past chats.maxToolResultChars it's cut, keeping the start and the end.
function cut(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text;
  const head = Math.floor(max * 0.7), tail = max - head;
  return `${text.slice(0, head)}\n\n[… ${text.length - max} characters cut by Nova to keep this chat small. ` +
    `If you need the missing part, read a narrower range or filter the output (head, tail, grep, offset and limit). …]\n\n${text.slice(-tail)}`;
}
function trimOutput(name, out, max) {
  if (name === 'Bash' && out && typeof out === 'object' && !out.isImage) {
    const stdout = cut(out.stdout, max), stderr = cut(out.stderr, max);
    return stdout === out.stdout && stderr === out.stderr ? null : { ...out, stdout, stderr };
  }
  if (name === 'Read' && out?.type === 'text' && typeof out.file?.content === 'string') {
    const content = cut(out.file.content, max);
    return content === out.file.content ? null : { ...out, file: { ...out.file, content } };
  }
  return null;
}
const trimHook = async (input) => {
  const max = Number(config.chats.maxToolResultChars);
  const updatedToolOutput = max > 0 ? trimOutput(input.tool_name, input.tool_response, max) : null;
  return updatedToolOutput ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput } } : {};
};

// Commands Claude Code says only make sense in its own terminal (exit, statusline and the like),
// from the latest chat that started. The composer leaves them out.
export const terminalCommands = new Set();

// The prompt of a streaming-input query: messages pushed in as the user sends them.
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

export class ChatRunner { // exported for scripts/ws-smoke.js; chats.js goes through runnerFor
  constructor({ id, session, profile, model, effort, mode, isNew, resumeAt, contextTokens }) {
    // id: the Nova chat. session: the Claude Code session it continues, the same id until the
    // chat first continues in a fresh session (handoff.js).
    Object.assign(this, { id, session, profile, model, effort, mode });
    this.state = 'idle';
    this.contextTokens = contextTokens ?? null; // the context's size at the last reply, for handoffs
    this.hidden = null; // the handoff turn in progress: { resolve, parts, cancelled }
    this.cutAt = resumeAt || null;
    this.pending = new Map(); // reqId -> resolve(PermissionResult)
    this.pendingInfo = new Map(); // reqId -> payload, replayed to tabs that reconnect
    this.tasks = new Map(); // task_id -> { started, progress } for sub-agents still running, replayed on open
    this.queued = new Map(); // uuid -> user_echo payload: messages sent mid-reply that Nova hasn't read yet, replayed on open
    this.inTurn = false; // a turn is under way (state stays 'running' between turns while messages wait)
    this.lastActive = Date.now();
    this.input = new InputQueue();

    const options = {
      ...sessionBase(profile),
      systemPrompt: {
        type: 'preset', preset: 'claude_code',
        // In the app the assistant is Nova; Claude is the model underneath, which it says
        // only when asked what it runs on.
        append: 'Your name is Nova. You are the assistant in Nova, a console the user reaches from a browser or phone, and the user ' +
          'knows you as Nova: call yourself Nova, never Claude or Claude Code. If asked what you run on or which model you are, ' +
          'say you are Nova, running on Anthropic\'s Claude through Claude Code. ' +
          `You are working under the "${profile}" profile. ` +
          `Notes specific to this profile live in ${profileDir(profile)}; read them when context about the profile would help.` +
          (buildsApps(profile) ? appsNote() : '')
      },
      includePartialMessages: true,
      canUseTool: (toolName, input, opts) => this.askPermission(toolName, input, opts),
      hooks: { PostToolUse: [{ matcher: 'Bash|Read', hooks: [trimHook] }] }
    };
    // The profile's tasks and sticky notes, and the apps guide, as tools (tools.js). Reading them never asks.
    const nova = novaServer(profile, buildsApps(profile));
    if (nova) Object.assign(options, { mcpServers: { nova }, allowedTools: READ_TOOLS });
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
    if (isNew) options.sessionId = session; else options.resume = session;
    // An edited message: carry on from the entry before it, leaving the rest off the chain. The
    // same after a handoff, which leaves its hidden turn off the chain.
    if (resumeAt) options.resumeSessionAt = resumeAt;

    this.query = query({ prompt: this.input, options });
    this.done = this.loop();
  }

  emit(payload) { hub.toProfile(this.profile, { chatId: this.id, ...payload }); }

  setState(state) {
    this.state = state;
    this.emit({ t: 'state', state });
  }

  // Would stopping the process now lose anything? Not while Claude is working, a prompt
  // waits for an answer, a sub-agent is still running, a message sent mid-reply is waiting, or a
  // handoff is being written.
  get busy() { return this.state === 'running' || this.pending.size > 0 || this.tasks.size > 0 || this.queued.size > 0 || !!this.hidden; }

  // Long enough that a fresh session from a handoff would cost much less than resuming it cold.
  get wantsHandoff() { return config.chats.handoffMinutes > 0 && !this.handoffTried && bigChat(this.contextTokens || 0); }

  async loop() {
    try {
      for await (const msg of this.query) {
        this.lastActive = Date.now();
        if (msg.type === 'rate_limit_event') { meta.noteRateLimit(msg.rate_limit_info); continue; }
        if (msg.type === 'command_lifecycle') { this.trackQueued(msg); continue; }
        // The handoff turn is the server's own: no tab sees it, and it isn't the chat's activity.
        if (this.hidden) { this.collectHidden(msg); continue; }
        if (msg.type === 'assistant' && !msg.parent_tool_use_id && msg.message?.usage) this.contextTokens = usageTokens(msg.message.usage);
        if (msg.type === 'system') this.trackSystem(msg);
        // Claude can start a turn on its own, e.g. when a background agent reports back.
        if (!msg.parent_tool_use_id && (msg.type === 'assistant' || msg.type === 'stream_event')) {
          this.inTurn = true;
          if (this.state === 'idle') this.setState('running');
        }
        if (FORWARD.has(msg.type)) this.emit({ t: 'sdk', msg });
        if (msg.type === 'result') {
          this.inTurn = false;
          // A message sent mid-reply that came too late for this turn starts the next one.
          if (!this.queued.size) this.setState('idle');
          q.chatActive.run(Date.now(), this.contextTokens, this.id);
          meta.refreshUsageSoon();
          if (this.stale) this.closeIfQuiet();
          // The plan was nearly used up while this chat was working (see the end of this file).
          else if (this.handoffWhenIdle && !this.busy) { this.handoffWhenIdle = false; this.startHandoff(); }
        }
      }
    } catch (err) {
      if (!this.hidden) this.emit({ t: 'error', message: `This chat's process stopped: ${err.message}` });
    } finally {
      this.hidden?.resolve(null);
      this.hidden = null;
      // A runner already replaced (new model, an edit) stays quiet, or tabs would see the
      // chat as closed while its new process works.
      const current = registry.get(this.id) === this;
      if (current) { registry.delete(this.id); this.setState('closed'); } else this.state = 'closed';
      for (const resolve of this.pending.values()) resolve({ behavior: 'deny', message: 'Session closed.' });
      this.pending.clear();
      this.pendingInfo.clear();
      this.tasks.clear();
      for (const uuid of [...this.queued.keys()]) this.dropQueued(uuid);
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
  // uuid: the message's id in the transcript, so it can be edited later.
  // While Nova is replying the message is an interjection: Claude Code queues it and reads it at
  // its next step, between tool calls, as its CLI does with a message typed mid-reply ('next'), or
  // stops the step it's on and reads it at once ('now'). A reply that ends before another step
  // takes it as the next turn. echo: the user_echo, kept to replay until it's read (trackQueued).
  send(content, uuid, { interject = 'next', echo = null } = {}) {
    this.lastActive = Date.now();
    const queued = this.state === 'running';
    if (queued) this.queued.set(uuid, echo);
    else { this.inTurn = true; this.setState('running'); }
    q.touchChat.run(Date.now(), this.model, this.effort, this.id);
    // The chain now carries on from the cut, so later resumes follow it without one.
    if (this.cutAt) { q.clearCut.run(this.id, this.session); this.cutAt = null; }
    this.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.session,
      uuid,
      ...(queued ? { priority: interject === 'now' ? 'now' : 'next' } : {})
    });
    return queued;
  }

  // Claude Code reports each queued message as queued, started (read: folded into the running
  // turn, or the start of a new one), completed, or cancelled. Tabs move a waiting message to
  // where Nova read it, or take it away.
  trackQueued(msg) {
    const uuid = msg.command_uuid;
    if (!this.queued.has(uuid)) return;
    if (msg.state === 'started' || msg.state === 'completed') {
      this.queued.delete(uuid);
      this.inTurn = true;
      if (this.state !== 'running') this.setState('running');
      this.emit({ t: 'interjected', uuid });
    } else if (msg.state === 'cancelled') this.dropQueued(uuid);
  }

  // A waiting message that will never be read (Stop, or the process ended). The tab that sent it
  // puts its text back in the box.
  dropQueued(uuid) {
    const echo = this.queued.get(uuid);
    if (!this.queued.delete(uuid)) return;
    this.emit({ t: 'interjection_dropped', uuid, from: echo?.from || null, text: echo?.text || '', files: echo?.attachments?.length || 0 });
    if (!this.queued.size && !this.inTurn && this.state === 'running') this.setState('idle');
  }

  queuedEchoes() { return [...this.queued.values()].filter(Boolean); }

  // ---- Handoff ------------------------------------------------------------------
  // One hidden turn asking Nova for a handoff (handoff.js), at low effort on the same model so
  // the cached history is still read from the cache. Resolves with { text, uuid }, text null if
  // it was cancelled or failed; uuid is the prompt's entry in the transcript, for the cut.
  async handOff() {
    const uuid = crypto.randomUUID();
    const effort = config.chats.handoffEffort;
    if (effort && effort !== this.effort) {
      try { await this.query.applyFlagSettings({ effortLevel: effort }); } catch (err) { console.error('Couldn\'t lower the effort for a handoff:', err.message); }
    }
    if (this.handoffCancelled) return null; // the user came back meanwhile: nothing was sent
    const text = await new Promise((resolve) => {
      this.hidden = { resolve, parts: [], cancelled: false };
      this.input.push({ type: 'user', message: { role: 'user', content: HANDOFF_REQUEST }, parent_tool_use_id: null, session_id: this.session, uuid });
    });
    return { text, uuid };
  }

  collectHidden(msg) {
    const h = this.hidden;
    if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
      for (const b of msg.message?.content || []) if (b.type === 'text') h.parts.push(b.text);
    }
    if (msg.type === 'result') {
      this.hidden = null;
      const text = h.parts.join('\n\n').trim();
      h.resolve(!h.cancelled && msg.subtype === 'success' && text ? text : null);
    }
  }

  // Writes the handoff and closes; handoffDone settles once the cut and handoff are stored.
  // It leaves the registry then even if the process is slow to exit, so the next send starts anew.
  startHandoff() {
    this.handoffTried = true;
    this.handoffDone = warmHandoff(this).finally(() => { if (registry.get(this.id) === this) registry.delete(this.id); });
    return this.handoffDone;
  }

  // The user came back while the handoff was being written: stop it, and wait until the process
  // has closed, so the chat resumes from before the hidden turn.
  async cancelHandoff() {
    if (!this.handoffDone) return;
    this.handoffCancelled = true;
    if (this.hidden) { this.hidden.cancelled = true; await this.interrupt(); }
    await this.handoffDone;
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
      title: describeCall(this.profile, toolName, input) || opts.title || null, // Nova's own tools name the task or note
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

  // Stop means stop everything: messages still waiting to be read go too.
  async interrupt() {
    try {
      const receipt = await this.query.interrupt({ cancelQueued: true });
      for (const uuid of receipt?.cancelled || []) this.dropQueued(uuid);
    } catch {}
  }

  // Closes the process if nothing would be lost; otherwise as soon as it's quiet. The next
  // send resumes the session.
  closeIfQuiet() {
    if (!this.busy) this.close();
    else this.stale = true;
  }

  close() { this.input.close(); try { this.query.close(); } catch {} }
}

// ---- Registry -----------------------------------------------------------------

const registry = new Map(); // chatId -> ChatRunner

// The chat's runner, started (or resumed) if it has none. row: the chat, already checked to
// belong to its profile (chats.js ownedChat). A changed model or effort restarts an idle
// process on the same session. rewind (an edited message, after stopRunner): { at } starts the
// session again from that transcript entry, or afresh when at is null (the first message).
// A plain resume starts after a handoff's hidden turn, if one is still at the end of the chain.
export function runnerFor(row, { model, effort, mode }, rewind = null) {
  let runner = registry.get(row.id);
  if (runner && (runner.model !== model || runner.effort !== effort) && runner.state !== 'running') {
    runner.close();
    registry.delete(row.id);
    runner = null;
  }
  if (!runner) {
    const isNew = rewind ? !rewind.at : row.title === null;
    const resumeAt = rewind ? rewind.at : isNew ? null : cutFor(row);
    runner = new ChatRunner({ id: row.id, session: sessionOf(row), profile: row.profile, model, effort,
      mode: mode || row.permission_mode || undefined, isNew, resumeAt: resumeAt || undefined, contextTokens: row.context_tokens });
    registry.set(row.id, runner);
  }
  return runner;
}

// Stops a chat's process and waits (up to 10 s) for it to exit, so nothing it writes on the
// way out lands in the session after an edit has rewound it.
export async function stopRunner(profile, id) {
  const runner = existingRunner(profile, id);
  if (!runner) return;
  registry.delete(id);
  runner.close();
  await Promise.race([runner.done, new Promise((r) => setTimeout(r, 10_000).unref())]);
}

export function existingRunner(profile, id) {
  const r = registry.get(id);
  return r && r.profile === profile ? r : null;
}

export const stateOf = (id) => registry.get(id)?.state || 'closed';
export const runnersOf = (profile) => [...registry.values()].filter((r) => r.profile === profile);

// Chats that would lose work if their process stopped now.
export const busyRunners = () => [...registry.values()].filter((r) => r.busy);

// Refuses an action that would stop every chat (a restart, an update) while any is busy.
// then: what to do once they're finished; when: added after "an answer", e.g. " after the test".
export function busyError(then, when = '') {
  const n = busyRunners().length;
  if (!n) return null;
  return new UserError(`${n === 1 ? 'A chat is' : `${n} chats are`} still working or waiting for an answer${when}. ` +
    `Stop them or let them finish, then ${then}.`, 409);
}

export function closeAllRunners() { for (const r of registry.values()) r.close(); }

// A profile's folders or approvals changed. Open chats pick that up at process start, so
// restart each one now if it's idle, or as soon as it finishes what it's doing.
export function refreshRunners(profile, except = null) {
  for (const r of runnersOf(profile)) if (r !== except) r.closeIfQuiet();
}

// The same for every profile, after a global setting that applies at process start changed.
export function refreshAllRunners() {
  for (const r of registry.values()) r.closeIfQuiet();
}

// Close processes that have sat idle, so concurrent chats don't pile up. A long chat is kept
// open until it has written its handoff, just before Claude's hour-long cache of its history
// expires, and closes once it has.
setInterval(() => {
  const now = Date.now();
  const idleCutoff = now - config.chats.idleMinutes * 60 * 1000;
  const handoffCutoff = now - Math.min(Number(config.chats.handoffMinutes) || 0, 55) * 60 * 1000;
  for (const r of registry.values()) {
    if (r.busy || r.state !== 'idle' || r.handoffDone) continue;
    if (r.wantsHandoff) { if (r.lastActive < handoffCutoff) r.startHandoff(); }
    else if (r.lastActive < idleCutoff) r.close();
  }
}, 60 * 1000).unref();

// Once the plan is nearly used up, a chat may not be able to write its handoff later, and a
// chat stranded by the limit would resume cold the next day. So every long chat writes it now:
// idle ones at once, working ones when they finish their turn.
meta.onHighUsage(() => {
  for (const r of registry.values()) {
    if (!r.wantsHandoff || r.handoffDone) continue;
    if (!r.busy && r.state === 'idle') r.startHandoff();
    else r.handoffWhenIdle = true;
  }
});
