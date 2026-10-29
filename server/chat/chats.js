// The chat list: each profile's chats in the active brain, sending to them, and their saved
// history. Every lookup goes through ownedChat, so a profile can never reach another
// profile's chat. The Claude Code process behind an open chat is runner.js. A long chat can
// span several Claude Code sessions, continued from a handoff (handoff.js); its history shows
// them all in turn.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deleteSession } from '@anthropic-ai/claude-agent-sdk';
import { config, CLAUDE_DIR, OLD_CLAUDE_DIR } from '../core/config.js';
import { q } from '../core/db.js';
import { hub } from '../core/hub.js';
import { UserError } from '../core/errors.js';
import { isAdmin } from '../accounts/profiles.js';
import { signedIn } from '../claude/meta.js';
import { runnerFor, existingRunner, stopRunner, stateOf } from './runner.js';
import { categoryIdFor } from './categories.js';
import { claimUploads, messageContent } from './uploads.js';
import { sessionEntries, sessionMessages, sessionOf, pastSessions, startsFresh, freshAfter, currentHandoff, coldHandoff,
  continuedBlock, isContinuedBlock, isToolResult } from './handoff.js';

export function ownedChat(profile, id) {
  const row = q.chat.get(id);
  return row && row.profile === profile ? row : null;
}

function requireChat(profile, id) {
  const row = ownedChat(profile, id);
  if (!row) throw new UserError('Chat not found.', 404);
  return row;
}

// fresh_after: when a message would start a fresh session from the chat's handoff (null: it
// wouldn't), so the composer can ask first when the setting says to.
// has_summary: the chat has a stored handoff to show (chatSummary).
export const listChats = (profile) => q.chats.all(profile).map(({ active_at, context_tokens, handoff_at, ...c }) =>
  ({ ...c, state: stateOf(c.id), has_summary: handoff_at != null, fresh_after: freshAfter({ ...c, active_at, context_tokens, handoff_at }) }));

// The chat's stored handoff, for the chat menu's Show summary. current: it covers the latest
// replies, so it's what a fresh session would start from; otherwise a new one is written first.
export function chatSummary(profile, id) {
  const row = requireChat(profile, id);
  if (!row.handoff) throw new UserError('This chat has no summary yet. Nova writes one when a long chat has been idle for a while.', 404);
  return { summary: row.handoff, writtenAt: row.handoff_at, current: !!currentHandoff(row) };
}

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
  delivered.delete(id);
  hub.toProfile(profile, { t: 'chats_changed', deleted: id });
}

// The last few clientIds each chat was sent, in memory only. A tab whose socket dropped before
// its message echoed reopens the chat and finds out from these whether the message arrived,
// so it can put an undelivered one back in the box rather than lose it or send it twice.
const delivered = new Map(); // chatId -> clientIds, newest last
function noteDelivered(chatId, clientId) {
  if (typeof clientId !== 'string' || !clientId || clientId.length > 100) return;
  const list = delivered.get(chatId) || [];
  list.push(clientId);
  delivered.set(chatId, list.slice(-10));
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

// Chats being moved to a fresh session (continueFresh), which can take a while when Haiku writes
// the handoff. Nothing else may be sent to them meanwhile.
const preparing = new Set();

// A handoff being written when the user comes back is stopped, and the chat read again, as the
// handoff may have left a cut to resume from (runner.cancelHandoff).
async function settleHandoff(profile, row) {
  const runner = existingRunner(profile, row.id);
  if (!runner?.handoffDone) return row;
  await runner.cancelHandoff();
  return ownedChat(profile, row.id) || row;
}

// Hands a message to the chat's process and echoes it to every tab, with the uuid it gets in
// the transcript so any tab can offer to edit it. A slash command must stay the whole message
// for Claude Code to run it, so it never gets the voice note. continued: the message starts a
// fresh session from the chat's handoff, which tabs mark above it.
async function deliver(profile, row, runner, content, { text, files, voice, mode, clientId, continued = false }) {
  if (mode && runner.mode !== mode) await runner.setMode(mode);
  else if (mode && row.permission_mode !== mode) q.setChatMode.run(mode, row.id, profile);
  if (voice && !text.startsWith('/')) content = [...(typeof content === 'string' ? [{ type: 'text', text: content }] : content), { type: 'text', text: VOICE_NOTE }];
  const uuid = crypto.randomUUID();
  runner.send(content, uuid);
  noteDelivered(row.id, clientId);
  hub.toProfile(profile, { t: 'user_echo', chatId: row.id, uuid, text, continued,
    attachments: files.map(({ id, name, size, type }) => ({ id, name, size, type })), from: clientId });
}

// Starts the chat on a fresh Claude Code session, from its handoff, after the cache of its
// history has expired. Without a current handoff Haiku writes one first; if that fails the chat
// resumes in full as before (null). The old session joins the chat's past sessions.
async function continueFresh(profile, row) {
  preparing.add(row.id);
  try {
    let handoff = currentHandoff(row);
    if (!handoff) {
      hub.toProfile(profile, { t: 'state', chatId: row.id, state: 'running' });
      hub.toProfile(profile, { t: 'notice', chatId: row.id,
        message: 'This chat has been idle for over an hour. Nova is summarising it so it can carry on in a fresh session, which uses far less of your plan…' });
      handoff = await coldHandoff(row);
      if (!handoff) {
        hub.toProfile(profile, { t: 'notice', chatId: row.id, message: 'The summary didn\'t work, so Nova is loading the chat\'s full history instead.' });
        return null;
      }
    }
    await stopRunner(profile, row.id);
    q.setSessions.run(crypto.randomUUID(), JSON.stringify([...pastSessions(row), sessionOf(row)]), row.id, profile);
    console.log(`${profile} continued a long chat from its handoff in a fresh session.`);
    return { handoff, row: ownedChat(profile, row.id) };
  } finally { preparing.delete(row.id); }
}

function requireQuiet(profile, row, busy, then) {
  if (preparing.has(row.id) || (busy ? existingRunner(profile, row.id)?.busy : existingRunner(profile, row.id)?.state === 'running')) {
    throw new UserError(`Nova is still working in this chat. Stop it or let it finish, then ${then}.`, 409);
  }
}

// Sends a message (text, attached uploads, or both) to a chat, starting or resuming its
// process. The first message also names the chat. Every tab of the profile gets an echo;
// clientId lets the sending tab recognise its own. A long chat whose cache has expired carries
// on in a fresh session, unless the setting or the user's answer (resume: 'fresh' | 'full') says
// otherwise; slash commands always resume in full, as they must be the whole message.
export async function sendMessage(profile, row, { text, attachments, voice, model, effort, mode, clientId, resume }) {
  const files = claimUploads(profile, attachments);
  if (!text && !files.length) return;
  requireSignedIn(profile);
  row = await settleHandoff(profile, row);
  requireQuiet(profile, row, false, 'send');
  let content = messageContent(profile, row.id, text, files);
  const fresh = !text.startsWith('/') && !existingRunner(profile, row.id)?.busy && startsFresh(row, resume)
    ? await continueFresh(profile, row) : null;
  if (fresh) {
    row = fresh.row;
    content = [continuedBlock(fresh.handoff), ...(typeof content === 'string' ? [{ type: 'text', text: content }] : content)];
  }
  const runner = runnerFor(row, { model, effort, mode }, fresh ? { at: null } : null);
  if (runner.state === 'running') throw new UserError('Nova is still responding. Stop it or wait before sending.');
  await deliver(profile, row, runner, content, { text, files, voice, mode, clientId, continued: !!fresh });
  if (!row.title) {
    const title = text || `Files: ${files.map((f) => f.name).join(', ')}`;
    q.renameChat.run(title.replace(/\s+/g, ' ').slice(0, 80), row.id, profile);
    hub.toProfile(profile, { t: 'chats_changed' });
  }
}

const isMainUser = (e) => e.type === 'user' && !e.isSidechain && !isToolResult(e.message?.content);

// The uploads a message's attachment manifest names, for the echo's capsules.
const manifestFiles = (profile, blocks) => blocks.flatMap((b) => (b.type === 'text' ? [...b.text.matchAll(/\[([0-9a-f-]{36})\]: /g)] : []))
  .map(([, id]) => q.upload.get(id)).filter((r) => r?.profile === profile);
const isManifest = (b) => b.type === 'text' && b.text.startsWith('<attachments>');

// Edits a message sent earlier and sends it again. The session carries on from the entry just
// before it (the SDK's resumeSessionAt), so the edit and the new reply become the chat's only
// branch: the old message and everything after it leave the history. They stay in the
// transcript file, off the chain, and changes Nova made to files meanwhile aren't undone.
// Attachments on the message go again, and so does the handoff on a fresh session's first
// message; only its typed text changes. A message in an earlier session takes the chat back to
// that session, and the later ones leave the chat like any other cut messages.
export async function editMessage(profile, row, { uuid, text, voice, model, effort, mode, clientId }) {
  requireSignedIn(profile);
  row = await settleHandoff(profile, row);
  requireQuiet(profile, row, true, 'edit');
  const chain = [...pastSessions(row), sessionOf(row)];
  let entry = null, where = chain.length;
  while (!entry && --where >= 0) entry = sessionEntries(chain[where]).find((e) => e.uuid === uuid && isMainUser(e)) || null;
  if (!entry) throw new UserError('That message can\'t be edited. Reload the chat and try again.', 404);
  const original = entry.message?.content;
  const kept = Array.isArray(original) ? original.filter((b) => b.type === 'image' || isManifest(b) || isContinuedBlock(b)) : [];
  const lead = kept.filter(isContinuedBlock), rest = kept.filter((b) => !isContinuedBlock(b));
  if (!text && !rest.length) throw new UserError('Type the new message before sending it.');
  const files = manifestFiles(profile, rest);
  const content = kept.length ? [...lead, ...(text ? [{ type: 'text', text }] : []), ...rest] : text;

  await stopRunner(profile, row.id);
  if (where < chain.length - 1) {
    q.setSessions.run(chain[where], JSON.stringify(chain.slice(0, where)), row.id, profile);
    row = ownedChat(profile, row.id);
  }
  const at = entry.parentUuid || null;
  // The first message: begin the session again. The old file goes, or the id would clash.
  if (!at) await deleteSession(sessionOf(row), { dir: config.paths.brainDir }).catch(() => {});
  const runner = runnerFor(row, { model, effort, mode }, { at });
  hub.toProfile(profile, { t: 'rewound', chatId: row.id, uuid });
  await deliver(profile, row, runner, content, { text, files, voice, mode, clientId, continued: lead.length > 0 });
}

// "Load full history" on a chat continued from a handoff: the first message of the fresh session
// goes again on the previous session, with its whole history, and the fresh session leaves the
// chat (like an edit's cut messages). For when the summary isn't enough; it costs a full resume.
export async function loadFullHistory(profile, row, { voice, model, effort, mode, clientId }) {
  const past = pastSessions(row);
  if (!past.length) throw new UserError('This chat has no earlier history to load.', 409);
  requireSignedIn(profile);
  row = await settleHandoff(profile, row);
  requireQuiet(profile, row, true, 'load the full history');
  const entry = sessionEntries(sessionOf(row)).find(isMainUser);
  const original = entry?.message?.content;
  if (!Array.isArray(original) || !original.some(isContinuedBlock)) {
    throw new UserError('The full history can\'t be loaded just now. Reload the chat and try again.', 409);
  }
  const blocks = original.filter((b) => !isContinuedBlock(b) && !(b.type === 'text' && b.text.startsWith('<voice-reply>')));
  const kept = blocks.filter((b) => b.type === 'image' || isManifest(b));
  const text = blocks.filter((b) => b.type === 'text' && !isManifest(b)).map((b) => b.text).join('\n').trim();
  const content = kept.length ? [...(text ? [{ type: 'text', text }] : []), ...kept] : text;

  await stopRunner(profile, row.id);
  q.setSessions.run(past.at(-1), JSON.stringify(past.slice(0, -1)), row.id, profile);
  row = ownedChat(profile, row.id);
  const runner = runnerFor(row, { model, effort, mode });
  hub.toProfile(profile, { t: 'rewound', chatId: row.id, uuid: entry.uuid });
  console.log(`${profile} loaded a chat's full history instead of its handoff.`);
  await deliver(profile, row, runner, content, { text, files: manifestFiles(profile, kept), voice, mode, clientId });
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
// A chat continued from handoffs lists each session's messages in turn, with a nova_continued
// marker where each fresh session begins; the last one can load the full history.
export async function openChat(profile, id) {
  const row = ownedChat(profile, id);
  if (!row) return null;
  const chain = [...pastSessions(row), sessionOf(row)];
  const messages = [];
  for (const [i, session] of chain.entries()) {
    if (i) messages.push({ type: 'nova_continued', uuid: `continued-${session}`, canLoad: i === chain.length - 1 });
    messages.push(...await sessionMessages(session));
  }
  const runner = existingRunner(profile, id);
  return { messages, state: preparing.has(id) ? 'running' : stateOf(id), delivered: delivered.get(id) || [],
    replay: [...(runner?.pendingRequests() || []), ...(runner?.runningTasks() || [])] };
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
