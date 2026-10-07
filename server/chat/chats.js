// The chat list: each profile's chats in the active brain, sending to them, and their saved
// history. Every lookup goes through ownedChat, so a profile can never reach another
// profile's chat. The Claude Code process behind an open chat is runner.js.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSessionMessages, deleteSession } from '@anthropic-ai/claude-agent-sdk';
import { config, CLAUDE_DIR, OLD_CLAUDE_DIR } from '../core/config.js';
import { q } from '../core/db.js';
import { hub } from '../core/hub.js';
import { UserError } from '../core/errors.js';
import { isAdmin } from '../accounts/profiles.js';
import { signedIn } from '../claude/meta.js';
import { runnerFor, existingRunner, stopRunner, stateOf } from './runner.js';
import { categoryIdFor } from './categories.js';
import { claimUploads, messageContent } from './uploads.js';

export function ownedChat(profile, id) {
  const row = q.chat.get(id);
  return row && row.profile === profile ? row : null;
}

function requireChat(profile, id) {
  const row = ownedChat(profile, id);
  if (!row) throw new UserError('Chat not found.', 404);
  return row;
}

export const listChats = (profile) => q.chats.all(profile).map((c) => ({ ...c, state: stateOf(c.id) }));

// A chat with no title yet: it gets one from its first message.
export function createChat(profile, { model, effort, categoryId }) {
  const id = crypto.randomUUID();
  q.addChat.run(id, profile, null, model || null, effort || null, Date.now(), Date.now(), categoryIdFor(profile, categoryId));
  return id;
}

// Renames a chat, files it under a category (null = uncategorised), or both. Both are
// checked before either changes.
export function updateChat(profile, id, body) {
  const chat = requireChat(profile, id);
  let title = null;
  if ('title' in body) {
    title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title) throw new UserError('Give the chat a name.');
    // A null title marks a chat that has never been sent to, so it can't be renamed yet.
    if (chat.title === null) throw new UserError('Send a message in this chat first, then rename it.', 409);
  }
  const categoryId = 'categoryId' in body ? categoryIdFor(profile, body.categoryId) : undefined;
  if (title) q.renameChat.run(title, id, profile);
  if (categoryId !== undefined) q.setChatCategory.run(categoryId, id, profile);
  hub.toProfile(profile, { t: 'chats_changed' });
}

// Unlists a chat and stops its process. The transcript file stays on disk.
export function deleteChat(profile, id) {
  requireChat(profile, id);
  existingRunner(profile, id)?.close();
  q.deleteChat.run(id, profile);
  hub.toProfile(profile, { t: 'chats_changed', deleted: id });
}

// Added to each message sent with spoken replies on, so that reply is short and reads well
// aloud. It's per message rather than in the system prompt, which is fixed when the Claude
// process starts: switching voice on or off then takes effect on the next message, with no
// restart. The transcript leaves it out when showing saved history (chat/transcript.js).
const VOICE_NOTE = `<voice-reply>
The user is listening rather than reading: your reply to this message will be read aloud by text-to-speech. Write for the ear:
- Be brief: usually one to three short sentences, well under 80 words, unless they ask for detail.
- Plain spoken sentences only: no headings, lists, tables, code blocks, links, file paths, symbols or emoji.
- Give the answer first. Say numbers, dates and times the way a person would.
- Keep any text between tool calls to a few words, or none.
- If the full answer is long, give the gist and offer to put the detail in a note or file.
This applies to this message only. Messages without this note get your usual written replies.
</voice-reply>`;

function requireSignedIn(profile) {
  if (signedIn() !== false) return;
  throw new UserError(isAdmin(profile)
    ? 'Nova isn\'t signed in to Claude. Sign in from Settings, Claude, then send again.'
    : 'Nova isn\'t signed in to Claude. Ask an admin to sign in from Settings, then send again.');
}

// Sends a message (text, attached uploads, or both) to a chat, starting or resuming its
// process. The first message also names the chat. Every tab of the profile gets an echo;
// clientId lets the sending tab recognise its own.

// Hands a message to the chat's process and echoes it to every tab, with the uuid it gets in
// the transcript so any tab can offer to edit it. A slash command must stay the whole message
// for Claude Code to run it, so it never gets the voice note.
async function deliver(profile, row, runner, content, { text, files, voice, mode, clientId }) {
  if (mode && runner.mode !== mode) await runner.setMode(mode);
  else if (mode && row.permission_mode !== mode) q.setChatMode.run(mode, row.id, profile);
  if (voice && !text.startsWith('/')) content = [...(typeof content === 'string' ? [{ type: 'text', text: content }] : content), { type: 'text', text: VOICE_NOTE }];
  const uuid = crypto.randomUUID();
  runner.send(content, uuid);
  hub.toProfile(profile, { t: 'user_echo', chatId: row.id, uuid, text, attachments: files.map(({ id, name, size, type }) => ({ id, name, size, type })), from: clientId });
}

export async function sendMessage(profile, row, { text, attachments, voice, model, effort, mode, clientId }) {
  const files = claimUploads(profile, attachments);
  if (!text && !files.length) return;
  requireSignedIn(profile);
  const runner = runnerFor(row, { model, effort, mode });
  if (runner.state === 'running') throw new UserError('Nova is still responding. Stop it or wait before sending.');
  const content = messageContent(profile, row.id, text, files);
  await deliver(profile, row, runner, content, { text, files, voice, mode, clientId });
  if (!row.title) {
    const title = text || `Files: ${files.map((f) => f.name).join(', ')}`;
    q.renameChat.run(title.replace(/\s+/g, ' ').slice(0, 80), row.id, profile);
    hub.toProfile(profile, { t: 'chats_changed' });
  }
}

// The session's transcript entries, straight from Claude Code's JSONL file: an edit needs each
// entry's parentUuid, which getSessionMessages leaves out. Lines that don't parse are skipped.
function sessionEntries(id) {
  const projects = path.join(CLAUDE_DIR, 'projects');
  let folders;
  try { folders = fs.readdirSync(projects); } catch { return []; }
  for (const folder of folders) {
    let text;
    try { text = fs.readFileSync(path.join(projects, folder, `${id}.jsonl`), 'utf8'); } catch { continue; }
    return text.split('\n').flatMap((line) => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
  }
  return [];
}

// Edits a message sent earlier and sends it again. The session carries on from the entry just
// before it (the SDK's resumeSessionAt), so the edit and the new reply become the chat's only
// branch: the old message and everything after it leave the history. They stay in the
// transcript file, off the chain, and changes Nova made to files meanwhile aren't undone.
// Attachments on the message go again; only its typed text changes.
export async function editMessage(profile, row, { uuid, text, voice, model, effort, mode, clientId }) {
  requireSignedIn(profile);
  if (existingRunner(profile, row.id)?.busy) throw new UserError('Nova is still working in this chat. Stop it or let it finish, then edit.', 409);
  const entry = sessionEntries(row.id).find((e) => e.uuid === uuid && e.type === 'user' && !e.isSidechain);
  const original = entry?.message?.content;
  if (!entry || (Array.isArray(original) && original.some((b) => b.type === 'tool_result'))) {
    throw new UserError('That message can\'t be edited. Reload the chat and try again.', 404);
  }
  const kept = Array.isArray(original) ? original.filter((b) => b.type === 'image' || (b.type === 'text' && b.text.startsWith('<attachments>'))) : [];
  if (!text && !kept.length) throw new UserError('Type the new message before sending it.');
  // The files the manifest names, for the echo's capsules.
  const files = kept.flatMap((b) => (b.type === 'text' ? [...b.text.matchAll(/\[([0-9a-f-]{36})\]: /g)] : []))
    .map(([, id]) => q.upload.get(id)).filter((r) => r?.profile === profile);
  const content = kept.length ? [...(text ? [{ type: 'text', text }] : []), ...kept] : text;

  await stopRunner(profile, row.id);
  const at = entry.parentUuid || null;
  // The first message: begin the session again. The old file goes, or the id would clash.
  if (!at) await deleteSession(row.id, { dir: config.paths.brainDir }).catch(() => {});
  const runner = runnerFor(row, { model, effort, mode }, { at });
  hub.toProfile(profile, { t: 'rewound', chatId: row.id, uuid });
  await deliver(profile, row, runner, content, { text, files, voice, mode, clientId });
}

// Sets a chat's permission mode: straight away in an open process, otherwise when it next starts.
export function changeMode(profile, row, mode) {
  const runner = existingRunner(profile, row.id);
  if (runner && runner.state !== 'closed') return runner.setMode(mode);
  q.setChatMode.run(mode, row.id, profile);
  hub.toProfile(profile, { t: 'mode', chatId: row.id, mode });
}

// What a tab needs to show a chat: its saved messages and state, then what to replay (prompts
// still waiting for an answer, sub-agents still running). Null if it isn't this profile's.
export async function openChat(profile, id) {
  if (!ownedChat(profile, id)) return null;
  let messages;
  try { messages = await getSessionMessages(id, { dir: config.paths.brainDir }); } catch { messages = []; }
  const runner = existingRunner(profile, id);
  return { messages, state: stateOf(id), replay: [...(runner?.pendingRequests() || []), ...(runner?.runningTasks() || [])] };
}

// Transcripts written before Nova had its own Claude folder are copied in, so older chats keep
// their history. Only Nova's chats, never over a newer copy; the originals stay.
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
