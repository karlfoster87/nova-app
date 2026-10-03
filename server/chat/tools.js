// Nova's own tools for Claude: the profile's tasks and sticky notes, so a chat can read and
// change them ("plan my week from the sprint note"). They run inside Nova as an in-process MCP
// server (no extra process, nothing to set up); Claude sees them as mcp__nova__<name>.
// One server per chat, built for the chat's profile. Every handler calls the same functions as
// the REST routes, which check view access and that each row is this profile's, so a chat can
// never reach another profile's tasks or notes. Read tools are allowed without asking (the
// runner lists READ_TOOLS in allowedTools); the rest ask like any other tool.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { q } from '../core/db.js';
import { hub } from '../core/hub.js';
import { UserError } from '../core/errors.js';
import { can } from '../accounts/access.js';
import { listTasks, createTask, updateTask, moveTask, deleteTask } from '../views/tasks.js';
import { listNotes, createNote, updateNote, moveNote, deleteNote, isSharedNote } from '../views/notes.js';

export const READ_TOOLS = ['mcp__nova__list_tasks', 'mcp__nova__list_notes'];
const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'grey'];

// The server's own date, for when Claude doesn't say. Nova runs at home, so it's usually the
// user's too; Claude knows the user's date and can pass it instead.
function serverToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A tool's result as text Claude reads. A UserError (bad input, a missing row, no access) goes
// back as a tool error with its message, so Claude can correct itself; anything else is logged.
const reply = (out) => ({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] });
function guarded(profile, run) {
  return async (args) => {
    try { return reply(await run(args)); } catch (err) {
      if (!(err instanceof UserError)) console.error(`A Nova tool failed for ${profile}:`, err);
      return { isError: true, ...reply(err instanceof UserError ? err.message : 'That didn\'t work because of an error inside Nova.') };
    }
  };
}

// Open Tasks and Notes views (and the tab badges) reload, as after a change in another tab.
// A shared note's change goes to every profile, as from the Notes view (routes/views.js).
const changed = (profile, t, everyone = false) => (everyone ? hub.toAll({ t, from: 'claude' }) : hub.toProfile(profile, { t, from: 'claude' }));

// Tasks as a tree: each top-level task with its subtasks nested, days in order, Unscheduled last.
function taskTree(list) {
  const kids = new Map();
  for (const t of list) {
    const key = t.parentId || '';
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(t);
  }
  const node = (t) => {
    const out = { id: t.id, title: t.title, state: t.state };
    if (!t.parentId) out.day = t.day;
    if (t.note) out.note = t.note;
    const children = (kids.get(t.id) || []).sort((a, b) => a.position - b.position).map(node);
    if (children.length) out.subtasks = children;
    return out;
  };
  return (kids.get('') || [])
    .sort((a, b) => (a.day === b.day ? a.position - b.position : a.day === null ? 1 : b.day === null ? -1 : a.day < b.day ? -1 : 1))
    .map(node);
}

const noteShape = (n) => ({ id: n.id, text: n.text, color: n.color, longStanding: !n.active, ...(n.shared ? { sharedBy: n.owner } : {}) });

const id = z.string().describe('The id, from list_tasks or list_notes.');
const day = z.string().describe('A date as YYYY-MM-DD.');

function taskTools(profile) {
  const g = (run) => guarded(profile, run);
  const write = (run) => g(async (args) => { const out = await run(args); changed(profile, 'tasks_changed'); return out; });
  const tools = [
    tool('list_tasks', 'List the user\'s tasks in Nova\'s Tasks view: tasks from today on, unscheduled ones, and unfinished ones from earlier days, ' +
      'each with its subtasks. States are waiting, in_progress and complete. Finished tasks on past days are not included.',
    { today: day.optional().describe('The user\'s date today, YYYY-MM-DD. Defaults to the server\'s date.') },
    g(({ today }) => {
      const tree = taskTree(listTasks(profile, today || serverToday()).tasks);
      return tree.length ? tree : 'There are no tasks from today on, and none unfinished or unscheduled.';
    }),
    { annotations: { readOnlyHint: true }, searchHint: 'tasks to-do list todo plan day week' })
  ];
  if (!can(profile, 'tasks', 'edit')) return tools;
  tools.push(
    tool('add_task', 'Add a task to Nova\'s Tasks view, on a day, unscheduled, or as a subtask of another task (subtasks take their parent\'s day). New tasks start as waiting.',
      { title: z.string().describe('Up to 200 characters.'), day: day.optional().describe('YYYY-MM-DD. Leave out for Unscheduled.'),
        parent_id: id.optional().describe('Make it a subtask of this task.'), note: z.string().optional().describe('Up to 4,000 characters.') },
      write(({ title, day: d, parent_id: parentId, note }) => createTask(profile, { title, day: d, parentId, note })),
      { searchHint: 'create new task todo' }),
    tool('update_task', 'Change a task\'s title, note or state. A subtask\'s state carries up: a parent becomes complete when all its subtasks are.',
      { id, title: z.string().optional(), note: z.string().optional().describe('Replaces the whole note. Empty clears it.'),
        state: z.enum(['waiting', 'in_progress', 'complete']).optional() },
      write(({ id: taskId, ...body }) => updateTask(profile, taskId, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)))),
      { searchHint: 'complete finish rename edit task state' }),
    tool('move_task', 'Move a task (with its subtasks) to another day, to Unscheduled, under another task, or before a sibling. ' +
      'Give parent_id to nest it; otherwise it goes to the top level of day (leave day out for Unscheduled).',
      { id, day: day.optional().describe('YYYY-MM-DD for a top-level task. Leave out for Unscheduled.'),
        parent_id: id.optional().describe('Put it under this task instead of on a day.'),
        before_id: id.optional().describe('Place it before this sibling. Leave out to put it last.') },
      write(({ id: taskId, day: d, parent_id: parentId, before_id: beforeId }) =>
        moveTask(profile, taskId, { day: d ?? null, parentId: parentId ?? null, beforeId: beforeId ?? null })),
      { searchHint: 'reschedule move nest reorder task day' }),
    tool('delete_task', 'Delete a task and all its subtasks. This can\'t be undone; to finish a task, set its state to complete instead.',
      { id },
      write(({ id: taskId }) => deleteTask(profile, taskId)),
      { annotations: { destructiveHint: true }, searchHint: 'remove delete task' })
  );
  return tools;
}

function noteTools(profile) {
  const g = (run) => guarded(profile, run);
  const write = (run) => g(async (args) => {
    const wasShared = isSharedNote(args.id);
    const out = await run(args);
    changed(profile, 'notes_changed', wasShared || out?.sharedBy !== undefined);
    return out;
  });
  const tools = [
    tool('list_notes', 'List the user\'s sticky notes in Nova\'s Notes view, in their order. Text is markdown. ' +
      'Long-standing notes are kept for reference; the rest are active. Notes with sharedBy are shown to every profile in Nova; ' +
      'anyone can change or delete them, so only change them when the user means the shared note.',
    {},
    g(() => { const notes = listNotes(profile).map(noteShape); return notes.length ? notes : 'There are no sticky notes.'; }),
    { annotations: { readOnlyHint: true }, searchHint: 'sticky notes memo board' })
  ];
  if (!can(profile, 'notes', 'edit')) return tools;
  const color = z.enum(COLORS);
  tools.push(
    tool('add_note', 'Add a sticky note to Nova\'s Notes view. It goes first. Text is markdown (bold, italics, bullet lists), up to 10,000 characters.',
      { text: z.string(), color: color.optional().describe('Defaults to yellow.'), long_standing: z.boolean().optional().describe('Keep it for reference rather than as an active note.') },
      write(({ text, color: c, long_standing: longStanding }) => {
        const note = createNote(profile, { text, color: c || 'yellow' });
        return noteShape(longStanding ? updateNote(profile, note.id, { active: false }) : note);
      }),
      { searchHint: 'create new sticky note' }),
    tool('update_note', 'Change a sticky note\'s text, colour, whether it\'s long-standing, or whether it\'s shown to every profile. Text replaces the whole note.',
      { id, text: z.string().optional(), color: color.optional(), long_standing: z.boolean().optional(),
        shared: z.boolean().optional().describe('Show it to every profile (true) or only its owner (false). Only the profile that shared it can stop sharing it.') },
      write(({ id: noteId, text, color: c, long_standing: longStanding, shared }) => {
        const body = {};
        if (text !== undefined) body.text = text;
        if (c !== undefined) body.color = c;
        if (longStanding !== undefined) body.active = !longStanding;
        if (shared !== undefined) body.shared = shared;
        return noteShape(updateNote(profile, noteId, body));
      }),
      { searchHint: 'edit sticky note' }),
    tool('move_note', 'Move a sticky note before another one, or to the end.',
      { id, before_id: id.optional().describe('Place it before this note. Leave out to put it last.') },
      write(({ id: noteId, before_id: beforeId }) => { moveNote(profile, noteId, { beforeId: beforeId ?? null }); return 'Moved.'; }),
      { searchHint: 'reorder sticky note' }),
    tool('delete_note', 'Delete a sticky note. This can\'t be undone.',
      { id },
      write(({ id: noteId }) => { deleteNote(profile, noteId); return 'Deleted.'; }),
      { annotations: { destructiveHint: true }, searchHint: 'remove delete sticky note' })
  );
  return tools;
}

// ---- Permission prompts ----------------------------------------------------
// A prompt for a write tool names the task or note it touches, so the user isn't asked to
// approve a bare id. Lookups are by (id, profile); anything not found is described plainly.

const clip = (s, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const STATE_WORDS = { waiting: 'waiting', in_progress: 'in progress', complete: 'complete' };

function ownTask(profile, id) { const r = id ? q.task.get(String(id)) : null; return r && r.profile === profile ? r : null; }
// A note this profile may see: its own, or a shared one.
function ownNote(profile, id) { const r = id ? q.note.get(String(id)) : null; return r && (r.profile === profile || r.shared) ? r : null; }
function subtaskCount(profile, id) {
  let n = 0;
  for (const c of q.taskChildren.all(id, profile)) n += 1 + subtaskCount(profile, c.id);
  return n;
}
const taskName = (t) => (t ? `the task "${clip(t.title)}"` : 'a task');
const noteName = (n) => (n ? `the ${n.shared ? 'shared ' : ''}sticky note "${clip(n.text.split('\n').find((l) => l.trim()) || 'empty')}"` : 'a sticky note');
const where = (profile, day, parentId) => {
  if (parentId) return ` under ${taskName(ownTask(profile, parentId))}`;
  return day ? ` on ${day}` : ' to Unscheduled';
};

export function describeCall(profile, toolName, input = {}) {
  const t = () => ownTask(profile, input.id), n = () => ownNote(profile, input.id);
  switch (toolName) {
    case 'mcp__nova__add_task': return `Add the task "${clip(input.title)}"${where(profile, input.day, input.parent_id)}`;
    case 'mcp__nova__update_task': {
      const changes = [input.title !== undefined && `rename it to "${clip(input.title)}"`, input.state && `mark it ${STATE_WORDS[input.state] || input.state}`,
        input.note !== undefined && (input.note ? 'replace its note' : 'clear its note')].filter(Boolean);
      return `Change ${taskName(t())}${changes.length ? `: ${changes.join(', ')}` : ''}`;
    }
    case 'mcp__nova__move_task': return `Move ${taskName(t())}${where(profile, input.day, input.parent_id)}`;
    case 'mcp__nova__delete_task': {
      const task = t(), subs = task ? subtaskCount(profile, task.id) : 0;
      return `Delete ${taskName(task)}${subs ? ` and its ${subs === 1 ? 'subtask' : `${subs} subtasks`}` : ''}`;
    }
    case 'mcp__nova__add_note': return 'Add a sticky note';
    case 'mcp__nova__update_note': return `Change ${noteName(n())}`;
    case 'mcp__nova__move_note': return `Move ${noteName(n())}`;
    case 'mcp__nova__delete_note': return `Delete ${noteName(n())}`;
    default: return null;
  }
}

// The tools a profile gets: none for a view it can't see, only the list tool for one it can
// only view. Access is checked again on every call, so a change while the chat runs still holds.
export const novaTools = (profile) => [
  ...(can(profile, 'tasks', 'read') ? taskTools(profile) : []),
  ...(can(profile, 'notes', 'read') ? noteTools(profile) : [])
];

// The nova MCP server for one chat, or null when the profile can't see tasks or notes.
export function novaServer(profile) {
  const tools = novaTools(profile);
  if (!tools.length) return null;
  return createSdkMcpServer({
    name: 'nova', version: '1.0.0', tools,
    instructions: 'These tools read and change the user\'s own tasks and sticky notes in Nova, the app this chat runs in. ' +
      'Use them when the user talks about their tasks, to-do list, plans for a day or week, or sticky notes. ' +
      'List first to get ids. Tasks and notes are not files in the brain folder.'
  });
}
