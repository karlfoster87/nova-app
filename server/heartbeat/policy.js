// What an unattended Heartbeat run may do. Nobody is there to answer a permission prompt, so a
// run never gets one: each tool call is allowed or held back by these rules, and what is held
// back is listed in the Train of Thought for the user to review. The rule (agreed 2026-10-29,
// edits added 2026-11-16) is "fully automated but non-destructive": reading, searching, looking
// things up and creating new things are fine. Held back:
//   - deleting or moving files, and Bash commands outside a read-only allowlist
//   - overwriting or editing a file the run didn't create itself
//   - git push, reset and anything else that changes a repository
//   - deleting tasks or notes, and changing schedules (a run can't reschedule itself)
//   - other MCP tools whose names say they delete, send, move or cancel something
//   - questions for the user (AskUserQuestion): the run records them as thoughts instead
// Anything not known to be safe is held back. Pure apart from checking whether a file exists, so
// the smoke test can try every rule. The runner applies it twice: as a PreToolUse hook, which
// comes before Claude Code's own permission rules (a shared "always allow" can't let a
// destructive call through), and in canUseTool for whatever still asks.
import fs from 'node:fs';
import path from 'node:path';
import { fold } from '../core/paths.js';

// Tools that only read, search, plan or hand work to a sub-agent (whose own calls meet these
// same rules).
const SAFE = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Agent',
  'ToolSearch', 'Skill', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'BashOutput', 'TaskOutput', 'KillShell', 'KillBash', 'TaskStop']);
const NOVA_SAFE = new Set(['list_tasks', 'add_task', 'update_task', 'move_task', 'list_notes', 'add_note', 'update_note', 'move_note',
  'apps_guide', 'thought', 'record_thought', 'resolve_question', 'list_heartbeats']);
// Other MCP tools are judged by name: one with any of these words is held back.
const RISKY_WORDS = /(^|[_\-.]|(?<=[a-z])(?=[A-Z]))(delete|remove|destroy|drop|purge|wipe|erase|trash|archive|move|rename|send|reply|forward|cancel|revoke|reset|clear|kill|uninstall|unsubscribe|overwrite|replace|merge|push|publish|transfer|pay)/i;

// ---- Bash -----------------------------------------------------------------------------

const READ_COMMANDS = new Set(['ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'sort', 'uniq', 'cut',
  'tr', 'date', 'echo', 'printf', 'pwd', 'whoami', 'hostname', 'which', 'where', 'file', 'stat', 'du', 'df', 'jq', 'basename', 'dirname',
  'realpath', 'readlink', 'tree', 'column', 'nl', 'diff', 'cmp', 'true', 'uptime', 'cd', 'sed', 'find', 'curl', 'git', 'test', '[']);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'shortlog']);

// Words of one simple command, with quotes removed. Null when quoting is unbalanced.
function words(segment) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"']+)/g;
  let m;
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2] ?? m[3]);
  return /["']/.test(segment.replace(re, '')) ? null : out;
}

// Why one simple command isn't read-only, or null when it is.
function commandProblem(w) {
  const [cmd, ...args] = w;
  if (!cmd) return null;
  if (/^\w+=/.test(cmd)) return 'sets variables for a command';
  const name = cmd.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, '');
  if (!READ_COMMANDS.has(name)) return `uses ${name}, which isn't on the read-only list`;
  if (name === 'find' && args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a))) return 'uses find to change files';
  if (name === 'sed' && args.some((a) => /^(-i|--in-place)/.test(a) || /^-[a-z]*i/.test(a))) return 'edits files with sed';
  if (name === 'sort' && args.some((a) => /^(-o|--output)/.test(a))) return 'writes a file with sort';
  if (name === 'curl') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if ((a === '-X' || a === '--request') && /^get$/i.test(args[i + 1] || '')) { i++; continue; }
      if (/^--(data|form|upload-file|output|remote-name|config|request|json)/.test(a)) return 'sends data or saves a file with curl';
      if (/^-[a-zA-Z]+$/.test(a) && /[dFTOoKX]/.test(a.slice(1))) return 'sends data or saves a file with curl';
    }
  }
  if (name === 'git') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
      if (args[i] === '-c' || args[i].startsWith('--exec-path') || args[i].startsWith('--config')) return 'changes git\'s settings';
      i += args[i] === '-C' ? 2 : 1;
    }
    const sub = args[i];
    if (!GIT_READ.has(sub)) return `runs git ${sub || ''}`.trim();
    if (sub === 'branch' && args.slice(i + 1).some((a) => /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream)/.test(a))) return 'changes a git branch';
  }
  return null;
}

// Why a shell command isn't read-only, or null when every part of it is. Pipes and && chains are
// fine as long as each command is; substitutions, writes to files and background jobs are not.
export function bashProblem(command) {
  let s = String(command || '').trim();
  if (!s) return null;
  if (/[`\n\r]|\$\(|<\(|>\(/.test(s)) return 'uses command substitution or several lines';
  s = s.replace(/\s\d?>&\d/g, ' ').replace(/\s\d?>\s*\/dev\/null/g, ' ').replace(/\s\d?>\s*nul\b/gi, ' ');
  if (/[<>]/.test(s)) return 'writes to or reads from a file with redirection';
  if (/(^|[^&])&($|[^&])/.test(s)) return 'starts a background job';
  for (const segment of s.split(/&&|\|\||;|\|/)) {
    const w = words(segment.trim());
    if (!w) return 'has unbalanced quotes';
    const problem = commandProblem(w);
    if (problem) return problem;
  }
  return null;
}

// ---- Deciding -------------------------------------------------------------------------

const clip = (s, n = 140) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const held = (what, why) => ({ allow: false, what, reason: `Held back: unattended Heartbeat runs can't ${why}. It has been noted for the user to ` +
  'review in the Train of Thought. Carry on without it, and mention it in your record_thought summary if it matters.' });

// run: { created: Set of folded paths this run created, cwd }. Returns { allow: true } or
// { allow: false, what (for the user), reason (for Nova) }. Allowing a Write of a new file adds
// it to run.created, so the run may keep working on files it made.
export function decide(toolName, input = {}, run = { created: new Set(), cwd: process.cwd() }) {
  const name = String(toolName || '');
  if (SAFE.has(name)) return { allow: true };
  if (name === 'AskUserQuestion') {
    return { allow: false, what: 'asked a question', reason: 'Nobody is watching this unattended Heartbeat run, so questions can\'t be answered now. ' +
      'Put the question in record_thought\'s question field for the user to pick up later, and carry on without the answer.' };
  }
  const file = typeof (input.file_path || input.notebook_path) === 'string' ? path.resolve(run.cwd || process.cwd(), input.file_path || input.notebook_path) : null;
  if (name === 'Write') {
    if (!file) return held('write a file without a path', 'write a file without a path');
    if (fs.existsSync(file) && !run.created.has(fold(file))) return held(`Overwrite ${file}`, 'overwrite a file they didn\'t create');
    run.created.add(fold(file));
    return { allow: true };
  }
  if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    if (file && run.created.has(fold(file))) return { allow: true };
    return held(`Edit ${file || 'a file'}`, 'edit a file they didn\'t create');
  }
  if (name === 'Bash') {
    const problem = bashProblem(input.command);
    return problem ? held(`Run: ${clip(input.command)}`, `run that command (it ${problem})`) : { allow: true };
  }
  if (name === 'PowerShell') return held(`Run in PowerShell: ${clip(input.command)}`, 'run PowerShell commands');
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp && mcp[1] === 'nova') {
    if (NOVA_SAFE.has(mcp[2])) return { allow: true };
    const what = { delete_task: 'Delete a task', delete_note: 'Delete a sticky note', add_heartbeat: 'Add a schedule',
      update_heartbeat: 'Change a schedule', delete_heartbeat: 'Delete a schedule' }[mcp[2]] || `Use ${mcp[2]}`;
    return held(what, mcp[2].endsWith('heartbeat') ? 'change schedules' : 'delete tasks or notes');
  }
  if (mcp) return RISKY_WORDS.test(mcp[2]) ? held(`Use ${mcp[2]} (${mcp[1]})`, `use ${mcp[2]}, which may change or remove something`) : { allow: true };
  return held(`Use ${name}`, `use ${name}`);
}
