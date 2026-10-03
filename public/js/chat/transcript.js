// The chat transcript: turns Agent SDK messages (the live stream or saved history) into DOM,
// with tool cards, sub-agent tasks, and permission and question cards. One Transcript per chat;
// chats.js feeds it server events and mounts the open one. It also tracks what Claude is doing
// (activity, running and recently finished agents) for the presence panel.
import { h, svgIcon } from '../lib/dom.js';
import { renderMarkdown } from '../lib/markdown.js';
import { fileChip } from '../lib/widgets.js';
import { confirmDialog } from '../lib/dialog.js';

// The manifest a message with attachments carries (server/chat/uploads.js messageContent),
// turned back into files for capsules: "- name (size, type) [id]: path".
function parseManifest(text) {
  return text.split('\n').map((line) => /^- (.+) \(([^,]+), ([^)]+)\) \[([0-9a-f-]{36})\]: /.exec(line))
    .filter(Boolean).map(([, name, sizeText, type, id]) => ({ id, name, sizeText, type }));
}

export const AGENT_TOOLS = new Set(['Task', 'Agent']);
// File and shell tools. Their cards are hidden from profiles with the User role (chat.css
// .simple-chat), since the commands and file contents mean little to a non-technical reader;
// admins still see them. Permission prompts for them always show.
const TECH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Bash', 'BashOutput', 'KillShell', 'KillBash', 'PowerShell', 'Glob', 'Grep', 'LS']);

// Speaker icons for a turn's gutter.
const TURN_ICONS = {
  user: ['M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 20 12Z'],
  assistant: ['M12 2.5 20.2 7.2v9.6L12 21.5l-8.2-4.7V7.2Z', 'M12 7v10M7.7 9.5l8.6 5M7.7 14.5l8.6-5']
};
const turnIcon = (kind) => svgIcon(TURN_ICONS[kind], { class: 'turn-icon' });
// A message's time: saved transcripts may carry an ISO timestamp; live ones are now.
const whenOf = (m) => { const t = Date.parse(m?.timestamp || ''); return Number.isNaN(t) ? null : t; };
const hhmm = (at) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
// An agent that finished stays in the presence panel this long, showing how it ended.
const LINGER_MS = 30 * 1000;

export function toolSummary(name, input = {}) {
  const pick = input.command || input.file_path || input.path || input.pattern || input.url ||
    input.query || input.description || input.subagent_type || input.notebook_path;
  if (pick) return String(pick).split('\n')[0];
  const first = Object.values(input).find((v) => typeof v === 'string');
  return first ? first.split('\n')[0] : '';
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content, null, 2);
}

export class Transcript {
  constructor(chatId, { onAnswer, onChange, where }) {
    this.chatId = chatId;
    this.where = where; // category name shown on an empty new chat
    this.onAnswer = onAnswer;
    this.onChange = onChange || (() => {});
    this.el = h('div', { class: 'transcript-inner' });
    this.tools = new Map();   // tool_use_id -> { el, status, body, sub, name, input, done, task }
    this.tasks = new Map();   // task_id -> sub-agent task, kept until the SDK reports it finished
    this.asks = new Map();    // reqId -> card element
    this.live = null;         // current streaming assistant message
    this.turn = null;         // the assistant turn being written: { el, body }
    this.ended = [];          // agents that finished recently, for the presence panel
    this.activity = 'idle';   // idle | thinking | writing | tool
    this.activityLabel = '';
    this.empty = true;
    this.showEmpty();
  }

  showEmpty() {
    const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    mark.setAttribute('viewBox', '0 0 32 32');
    mark.setAttribute('class', 'empty-mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = '<path d="M16 2.5 27.7 9.3v13.4L16 29.5 4.3 22.7V9.3Z"/><circle cx="16" cy="16" r="6.5"/><circle cx="16" cy="16" r="2.2"/>';
    this.el.replaceChildren(h('div', { class: 'empty' }, mark,
      h('h2', {}, this.where ? `Start a chat in ${this.where}` : 'Start a chat'), h('p', {}, 'Claude works from your brain folder and this profile\'s notes.')));
  }

  append(node, parent) {
    if (this.empty) { this.el.replaceChildren(); this.empty = false; }
    (parent || this.el).append(node);
    this.onChange();
  }

  setActivity(activity, label = '') { this.activity = activity; this.activityLabel = label; }

  // ---- Turns -----------------------------------------------------------
  // Each turn is an icon, the speaker and time, then what was said. Everything Claude
  // does between two user messages (text, thinking, tools, prompts) shares one turn.
  startTurn(kind, at) {
    const body = h('div', { class: 'turn-body' });
    const time = at ? h('time', { class: 'turn-time', datetime: new Date(at).toISOString() }, hhmm(at)) : null;
    const el = h('article', { class: `turn turn-${kind}` }, turnIcon(kind),
      h('div', { class: 'turn-head' }, h('span', { class: 'turn-name' }, kind === 'user' ? 'You' : 'Claude'), time), body);
    this.append(el);
    return { el, body };
  }

  assistantBody(at = Date.now()) {
    if (!this.turn) this.turn = this.startTurn('assistant', at);
    return this.turn.body;
  }

  // Into the current turn if there is one, else on its own.
  appendInTurn(node) {
    if (this.turn) { this.turn.body.append(node); this.onChange(); } else this.append(node);
  }

  // ---- User side -------------------------------------------------------
  addUser(text, files = [], at = Date.now()) {
    this.turn = null;
    const { body } = this.startTurn('user', at);
    body.append(h('div', { class: 'msg-user' }, text || null,
      files.length ? h('ul', { class: 'file-chips' }, files.map((f) => fileChip(f, { href: `/api/uploads/${f.id}` }))) : null));
    this.onChange();
  }

  addNotice(text, isError = false) {
    this.appendInTurn(h('div', { class: `notice${isError ? ' error' : ''}` }, text));
  }

  // ---- Assistant blocks ------------------------------------------------
  makeThinking(text, open = false) {
    const body = h('div', { class: 'body' }, text || '');
    return { el: h('details', { class: 'block thinking', open }, h('summary', {}, 'Thinking'), body), body };
  }

  makeTool(block) {
    const status = h('span', { class: 'tool-status running' }, 'running');
    const detail = h('span', { class: 'summary-detail' }, toolSummary(block.name, block.input));
    const inputPre = h('pre', {}, JSON.stringify(block.input || {}, null, 2));
    const sub = AGENT_TOOLS.has(block.name) ? h('div', { class: 'subagent' }) : null;
    const body = h('div', { class: 'body' }, inputPre, sub);
    const el = h('details', { class: `block tool${TECH_TOOLS.has(block.name) ? ' tech' : ''}` }, h('summary', {}, h('span', { class: 'tool-name' }, block.name), detail, status), body);
    const prev = this.tools.get(block.id); // the streamed version of this call, if any
    const entry = { el, status, body, sub, inputPre, detail, name: block.name, input: block.input || {}, done: false,
      startedAt: prev?.startedAt || Date.now() };
    this.tools.set(block.id, entry);
    if (prev?.task) this.syncTaskTool(prev.task);
    return entry;
  }

  renderContent(content, container) {
    for (const block of content || []) {
      if (block.type === 'text' && block.text?.trim()) {
        const div = h('div', { class: 'prose' }); div.innerHTML = renderMarkdown(block.text); container.append(div);
      } else if (block.type === 'thinking' && block.thinking) {
        container.append(this.makeThinking(block.thinking).el);
      } else if (block.type === 'redacted_thinking') {
        container.append(this.makeThinking('(Thinking not shown for this turn.)').el);
      } else if (block.type === 'tool_use') {
        container.append(this.makeTool(block).el);
      }
    }
  }

  attachResults(content) {
    for (const block of content || []) {
      if (block.type !== 'tool_result') continue;
      const t = this.tools.get(block.tool_use_id);
      if (!t) continue;
      // A background agent's tool result is only a "launched" placeholder; the task decides when it's done.
      if (t.task?.status !== 'running') {
        if (!t.done && AGENT_TOOLS.has(t.name) && !t.task) this.endAgent(block.tool_use_id, t, block.is_error ? 'failed' : 'done');
        t.done = true;
        t.status.textContent = block.is_error ? 'error' : 'done';
        t.status.className = 'tool-status';
        if (block.is_error) t.el.classList.add('error');
      }
      const text = resultText(block.content);
      if (text) t.body.append(h('pre', {}, text.length > 20000 ? text.slice(0, 20000) + '\n…' : text));
    }
    this.onChange();
  }

  // ---- Live stream -----------------------------------------------------
  handleStream(ev) {
    if (ev.type === 'message_start') {
      this.live = { el: h('div', { class: 'msg-assistant live' }), blocks: [] };
      this.assistantBody().append(this.live.el);
      this.onChange();
      return;
    }
    if (!this.live) return;
    if (ev.type === 'content_block_start') {
      const cb = ev.content_block;
      let b;
      if (cb.type === 'text') {
        b = { type: 'text', buf: '', el: h('div', { class: 'prose' }) };
        this.setActivity('writing');
      } else if (cb.type === 'thinking') {
        const t = this.makeThinking('', true);
        b = { type: 'thinking', el: t.el, body: t.body };
        this.setActivity('thinking');
      } else if (cb.type === 'tool_use') {
        const t = this.makeTool({ ...cb, input: {} });
        b = { type: 'tool_use', el: t.el, entry: t, json: '' };
        this.setActivity('tool', cb.name);
      } else return;
      this.live.blocks[ev.index] = b;
      this.live.el.append(b.el);
      this.onChange();
    } else if (ev.type === 'content_block_delta') {
      const b = this.live.blocks[ev.index];
      if (!b) return;
      const d = ev.delta;
      if (d.type === 'text_delta') { b.buf += d.text; this.scheduleMarkdown(b); }
      else if (d.type === 'thinking_delta') { b.body.textContent += d.thinking; this.onChange(); }
      else if (d.type === 'input_json_delta') { b.json += d.partial_json; b.entry.inputPre.textContent = b.json; }
    }
  }

  scheduleMarkdown(b) {
    if (b.pending) return;
    b.pending = true;
    requestAnimationFrame(() => { b.pending = false; b.el.innerHTML = renderMarkdown(b.buf); this.onChange(); });
  }

  // Final assistant message replaces whatever was streamed for it.
  handleAssistant(msg, parentId) {
    const content = msg.message?.content || [];
    if (parentId) {
      const parent = this.tools.get(parentId);
      if (parent?.sub) { this.renderContent(content, parent.sub); this.onChange(); }
      // A sub-agent calling a tool shows as a burst of activity on its presence row.
      if (parent && content.some((b) => b.type === 'tool_use')) {
        parent.activeAt = Date.now();
        for (const task of this.tasks.values()) if (task.toolUseId === parentId) task.activeAt = Date.now();
      }
      return;
    }
    const el = h('div', { class: 'msg-assistant' });
    this.renderContent(content, el);
    if (this.live) { this.live.el.replaceWith(el); this.live = null; this.onChange(); }
    else { this.assistantBody(whenOf(msg) || Date.now()).append(el); this.onChange(); }
    const running = [...this.tools.values()].find((t) => !t.done);
    if (running) this.setActivity('tool', running.name);
  }

  handleSdk(msg) {
    switch (msg.type) {
      case 'stream_event':
        if (!msg.parent_tool_use_id) this.handleStream(msg.event);
        break;
      case 'assistant':
        this.handleAssistant(msg, msg.parent_tool_use_id);
        break;
      case 'user':
        if (Array.isArray(msg.message?.content)) this.attachResults(msg.message.content);
        break;
      case 'result': {
        this.live = null;
        this.setActivity('idle');
        for (const [id, t] of this.tools) {
          if (!t.done && t.task?.status !== 'running') {
            if (AGENT_TOOLS.has(t.name) && !t.task) this.endAgent(id, t, 'stopped');
            t.done = true; t.status.textContent = 'stopped'; t.status.className = 'tool-status';
          }
        }
        const secs = Math.round((msg.duration_ms || 0) / 1000);
        const bits = [`${secs}s`];
        if (msg.num_turns > 1) bits.push(`${msg.num_turns} steps`);
        if (msg.subtype && msg.subtype !== 'success') bits.push(msg.subtype.replace(/_/g, ' '));
        this.appendInTurn(h('div', { class: 'turn-meta' }, bits.join(', ')));
        this.turn = null;
        break;
      }
      case 'system':
        if (msg.subtype === 'compact_boundary') this.addNotice('Earlier context was summarised to make room.');
        else if (msg.subtype?.startsWith('task_')) this.handleTask(msg);
        break;
    }
  }

  // ---- Sub-agent tasks -------------------------------------------------
  // Agents often run in the background: their Agent tool call returns at once and
  // the real lifecycle arrives as task_started / task_progress / task_notification.
  handleTask(msg) {
    let task = this.tasks.get(msg.task_id);
    if (!task) {
      if (msg.subtype !== 'task_started' && msg.subtype !== 'task_progress') return;
      if (msg.ambient || msg.skip_transcript) return;
      const isAgent = msg.task_type === 'local_agent' || msg.subagent_type || AGENT_TOOLS.has(this.tools.get(msg.tool_use_id)?.name);
      if (!isAgent) return;
      task = {
        id: msg.task_id, toolUseId: msg.tool_use_id, status: 'running',
        name: msg.subagent_type || 'Sub-agent', description: msg.description || '',
        startedAt: Date.now() - (msg.usage?.duration_ms || 0)
      };
      this.tasks.set(msg.task_id, task);
      // Its tool call may have been counted as finished before the task was known.
      this.ended = this.ended.filter((e) => e.id !== msg.tool_use_id);
    }
    if (msg.description) task.description = msg.description;
    if (msg.subtype === 'task_progress') {
      task.lastTool = msg.last_tool_name || task.lastTool;
      task.summary = msg.summary || task.summary;
      const uses = msg.usage?.tool_uses ?? task.toolUses;
      if (uses > (task.toolUses || 0) || (msg.last_tool_name && msg.last_tool_name !== task.lastToolSeen)) task.activeAt = Date.now();
      task.lastToolSeen = msg.last_tool_name || task.lastToolSeen;
      task.toolUses = uses;
      if (msg.usage?.duration_ms) task.startedAt = Date.now() - msg.usage.duration_ms;
    } else if (msg.subtype === 'task_updated') {
      const s = msg.patch?.status;
      if (s === 'completed' || s === 'failed' || s === 'killed') task.status = s === 'killed' ? 'stopped' : s;
    } else if (msg.subtype === 'task_notification') {
      task.status = msg.status;
      if (msg.usage?.tool_uses != null) task.toolUses = msg.usage.tool_uses;
    }
    this.syncTaskTool(task);
    if (task.status !== 'running') {
      this.tasks.delete(task.id);
      this.endAgent(task.id, task, { completed: 'done', failed: 'failed' }[task.status] || 'stopped');
    }
    this.onChange();
  }

  // Remembers a finished agent for a short while, so the presence panel can show how it ended.
  endAgent(id, a, state) {
    if (this.ended.some((e) => e.id === id)) return;
    const isCall = AGENT_TOOLS.has(a.name); // a foreground Agent call rather than a tracked task
    this.ended.push({ id, name: isCall ? a.input?.subagent_type || 'Sub-agent' : a.name,
      task: (isCall ? a.input?.description : a.description) || '', toolUses: a.toolUses, startedAt: a.startedAt, endedAt: Date.now(), state });
  }

  syncTaskTool(task) {
    const t = this.tools.get(task.toolUseId);
    if (!t) return;
    t.task = task;
    const running = task.status === 'running';
    t.done = !running;
    t.status.textContent = running ? 'running' : { completed: 'done', failed: 'error', stopped: 'stopped' }[task.status] || task.status;
    t.status.className = running ? 'tool-status running' : 'tool-status';
    t.el.classList.toggle('error', task.status === 'failed');
  }

  // The Claude process ended, so nothing it started is still running.
  endTasks() {
    for (const task of this.tasks.values()) { task.status = 'stopped'; this.syncTaskTool(task); this.endAgent(task.id, task, 'stopped'); }
    this.tasks.clear();
    this.onChange();
  }

  // ---- Saved history ---------------------------------------------------
  loadHistory(messages) {
    this.tools.clear();
    this.tasks.clear();
    this.ended = [];
    this.turn = null;
    this.el.replaceChildren();
    this.empty = true;
    if (!messages.length) { this.showEmpty(); return; }
    for (const m of messages) {
      const content = m.message?.content;
      if (m.type === 'assistant') this.handleAssistant(m, m.parent_tool_use_id);
      else if (m.type === 'user' && !m.parent_tool_use_id) {
        if (typeof content === 'string') this.addUser(content, [], whenOf(m));
        else if (Array.isArray(content)) {
          // The spoken-replies note (server/chat/chats.js VOICE_NOTE) is for Claude, not the reader.
          const texts = content.filter((c) => c.type === 'text' && !c.text.startsWith('<voice-reply>')).map((c) => c.text);
          const manifest = texts.find((t) => t.startsWith('<attachments>'));
          const files = manifest ? parseManifest(manifest) : [];
          let text = texts.filter((t) => t !== manifest).join('\n').trim();
          if (text.startsWith('<')) text = ''; // text Claude Code added itself, not typed by the user
          if (text || files.length) this.addUser(text, files, whenOf(m));
          this.attachResults(content);
        }
      } else if (m.type === 'user' && Array.isArray(content)) this.attachResults(content);
    }
    for (const t of this.tools.values()) if (!t.done) { t.done = true; t.status.textContent = 'no result'; t.status.className = 'tool-status'; }
  }

  // ---- Permission prompts and questions -------------------------------
  addPermission(req) {
    if (this.asks.has(req.reqId)) return;
    const card = req.toolName === 'AskUserQuestion' ? this.questionCard(req) : this.permissionCard(req);
    this.asks.set(req.reqId, card);
    this.appendInTurn(card);
  }

  permissionCard(req) {
    const decide = (behavior) => this.onAnswer(req.reqId, { behavior });
    const summary = toolSummary(req.toolName, req.input) || JSON.stringify(req.input, null, 2);
    const rules = req.alwaysRules?.join('\n');
    const addFolder = async () => {
      if (!(await confirmDialog({ title: 'Let Claude use this folder in all your chats?', confirm: 'Add folder',
        message: `${req.folder}\n\nYou can remove it later in Settings, under Permissions.` }))) return;
      decide('add_folder');
    };
    return h('div', { class: 'ask', role: 'group', 'aria-label': 'Permission request' },
      h('h3', {}, req.title || `Allow Claude to use ${req.toolName}?`),
      req.blockedPath ? h('p', { class: 'muted' }, `Outside the allowed folders: ${req.blockedPath}`) : null,
      h('pre', {}, summary),
      rules ? h('p', { class: 'muted' }, req.alwaysRules.length > 1 ? 'Always allow saves these rules for your profile:' : 'Always allow saves this rule for your profile:') : null,
      rules ? h('pre', {}, rules) : null, // long rules scroll inside the block like the summary
      req.folder ? h('p', { class: 'muted' }, `Add this folder lets every chat in your profile use ${req.folder}`) : null,
      h('div', { class: 'row' },
        h('button', { class: 'send-btn', type: 'button', onclick: () => decide('allow') }, 'Allow once'),
        req.canRemember ? h('button', { class: 'text-btn', type: 'button', onclick: () => decide('allow_session') }, 'Allow for this chat') : null,
        rules ? h('button', { class: 'text-btn', type: 'button', onclick: () => decide('always') }, 'Always allow') : null,
        req.folder ? h('button', { class: 'text-btn', type: 'button', onclick: addFolder }, 'Add this folder') : null,
        h('button', { class: 'stop-btn', type: 'button', onclick: () => decide('deny') }, 'Deny')));
  }

  questionCard(req) {
    const questions = req.input?.questions || [];
    const groups = questions.map((q, qi) => {
      const type = q.multiSelect ? 'checkbox' : 'radio';
      const name = `${req.reqId}-${qi}`;
      const other = h('input', { class: 'other', type: 'text', placeholder: 'Or type your own answer' });
      const opts = q.options.map((o) => h('label', { class: 'option' },
        h('input', { type, name, value: o.label }), h('span', {}, o.label), o.description ? h('small', {}, o.description) : null));
      return { q, name, other, el: h('div', { class: 'question' }, h('p', {}, q.question), opts, other) };
    });
    const submit = () => {
      const answers = {};
      for (const g of groups) {
        const picked = [...card.querySelectorAll(`input[name="${g.name}"]:checked`)].map((i) => i.value);
        if (g.other.value.trim()) picked.push(g.other.value.trim());
        answers[g.q.question] = picked.join(', ');
      }
      this.onAnswer(req.reqId, { behavior: 'answer', answers });
    };
    const card = h('div', { class: 'ask', role: 'group', 'aria-label': 'Question from Claude' },
      h('h3', {}, questions.length > 1 ? 'Claude has a few questions' : 'Claude has a question'),
      groups.map((g) => g.el),
      h('div', { class: 'row' },
        h('button', { class: 'send-btn', type: 'button', onclick: submit }, 'Send answers'),
        h('button', { class: 'text-btn', type: 'button', onclick: () => this.onAnswer(req.reqId, { behavior: 'deny', message: 'The user skipped the question.' }) }, 'Skip')));
    return card;
  }

  resolveAsk(reqId) {
    const card = this.asks.get(reqId);
    if (!card) return;
    card.classList.add('resolved');
    card.querySelectorAll('input').forEach((i) => { i.disabled = true; });
    this.asks.delete(reqId);
  }

  get waiting() { return this.asks.size > 0; }

  // Tracked tasks first; then foreground Agent calls the SDK sent no task messages for.
  // state: starting (no tool calls yet), tool (called one in the last moments) or working.
  runningAgents() {
    const now = Date.now();
    const stateOf = (a) => (a.activeAt && now - a.activeAt < 2500 ? 'tool' : !a.toolUses && now - a.startedAt < 4000 ? 'starting' : 'working');
    const agents = [...this.tasks.values()].map((t) => ({
      id: t.id, name: t.name, task: t.description,
      detail: t.summary || (t.lastTool ? `Using ${t.lastTool}` : ''), toolUses: t.toolUses, startedAt: t.startedAt, state: stateOf(t)
    }));
    const tracked = new Set([...this.tasks.values()].map((t) => t.toolUseId));
    for (const [id, t] of this.tools) {
      if (!AGENT_TOOLS.has(t.name) || t.done || tracked.has(id)) continue;
      agents.push({ id, name: t.input.subagent_type || 'Sub-agent', task: t.input.description || '', detail: '', startedAt: t.startedAt, state: stateOf(t) });
    }
    return agents;
  }

  // Agents that finished in the last LINGER_MS, newest first: { ..., state: done | failed | stopped, endedAt }.
  recentAgents() {
    const now = Date.now();
    this.ended = this.ended.filter((e) => now - e.endedAt < LINGER_MS);
    return [...this.ended].reverse();
  }
}
