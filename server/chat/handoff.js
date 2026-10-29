// Long chats and the prompt cache. Claude keeps a chat's history cached for an hour after its last
// use, and reading it from the cache costs about a tenth of sending it again. So a long chat left
// idle writes a short handoff while its history is still cached (warmHandoff, a hidden turn), and
// when it's reopened after the cache has expired Nova starts a fresh session from that handoff
// instead of re-sending the whole history at full price (chats.js sendMessage). A chat that went
// cold without a handoff gets one from Haiku, written from its transcript's text (coldHandoff).
// The fresh session belongs to the same Nova chat: the chat keeps a chain of session ids, and
// its history shows every session in turn.
import fs from 'node:fs';
import path from 'node:path';
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { config, agentEnv, CLAUDE_DIR } from '../core/config.js';
import { q } from '../core/db.js';

export const CACHE_MS = 60 * 60 * 1000;

const ASK = 'the goal, decisions made, files and entities touched (with their paths), the current state, open questions, ' +
  'and the next step. At most about 400 words.';
// The hidden turn's prompt starts with this tag, so its turn can be left out of the history.
const HANDOFF_TAG = '<nova-handoff-request>';
export const HANDOFF_REQUEST = `${HANDOFF_TAG}\nWrite a handoff for continuing this conversation in a fresh session: ${ASK} ` +
  'Don\'t use tools. Reply with the handoff only.';

// The first message of a fresh session carries the handoff in a block of its own before what the
// user typed; the transcript shows it as a "Continued from summary" marker (chat/transcript.js).
const CONTINUED_TAG = '<previous-session>';
export const continuedBlock = (handoff) => ({ type: 'text',
  text: `${CONTINUED_TAG}\nContext from the previous session:\n${handoff}\n\n---\n</previous-session>` });
export const isContinuedBlock = (b) => b?.type === 'text' && b.text.startsWith(CONTINUED_TAG);

// ---- Sessions -------------------------------------------------------------------

export const sessionOf = (row) => row.session_id || row.id;
export function pastSessions(row) {
  try { const list = JSON.parse(row.past_sessions || '[]'); return Array.isArray(list) ? list.map(String) : []; } catch { return []; }
}

// Where to resume the chat's current session so the hidden handoff turn stays off its chain, if
// the last handoff left one there.
export function cutFor(row) {
  try { const cut = JSON.parse(row.handoff_cut || 'null'); return cut?.session === sessionOf(row) ? cut.at : null; } catch { return null; }
}

// A session's transcript entries, straight from Claude Code's JSONL file: an edit needs each
// entry's parentUuid, which getSessionMessages leaves out. Lines that don't parse are skipped.
export function sessionEntries(id) {
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

// A session's messages along its current chain, without hidden handoff turns.
export async function sessionMessages(id) {
  try { return withoutHandoffs(await getSessionMessages(id, { dir: config.paths.brainDir })); } catch { return []; }
}

export const isToolResult = (c) => Array.isArray(c) && c.some((b) => b.type === 'tool_result');
const isHandoffRequest = (c) => (typeof c === 'string' ? c : Array.isArray(c) && c[0]?.type === 'text' ? c[0].text : '').startsWith(HANDOFF_TAG);

// Drops each handoff prompt and Nova's reply to it, up to the next message the user sent. One the
// chain still carries (resumed before it could be cut) would otherwise show in the history.
export function withoutHandoffs(messages) {
  let hiding = false;
  return messages.filter((m) => {
    const c = m.message?.content;
    if (m.type === 'user' && !m.parent_tool_use_id && !isToolResult(c)) hiding = isHandoffRequest(c);
    return !hiding;
  });
}

// ---- When to continue fresh ----------------------------------------------------

// The context one reply used: everything the model read, plus what it wrote.
export const usageTokens = (u) => u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) : null;

// The chat's size at its last reply. Chats from before v0.8 don't have it stored, so it's read
// from the transcript once.
function contextOf(row) {
  if (row.context_tokens != null) return row.context_tokens;
  const entries = sessionEntries(sessionOf(row));
  let tokens = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'assistant' && !e.isSidechain && e.message?.usage) { tokens = usageTokens(e.message.usage); break; }
  }
  q.setChatContext.run(tokens, row.id);
  return tokens;
}

export const bigChat = (tokens) => config.chats.handoffMinTokens > 0 && tokens >= config.chats.handoffMinTokens;

// The cache was last used by a reply, or by the hidden handoff turn, which reads the whole history.
const lastCacheUse = (row) => Math.max(row.active_at || row.updated_at || 0, row.handoff_at || 0);

// When a send to this chat would start a fresh session, or null if it never would now (it's small
// or has never been sent to). The chat list carries it, so the composer can ask in 'ask' mode.
export function freshAfter(row) {
  if (row.title === null || !bigChat(row.context_tokens || 0)) return null;
  return lastCacheUse(row) + CACHE_MS;
}

// Whether a message sent now should start a fresh session. choice: the user's answer when Nova
// asked ('fresh' or 'full'); without one, 'ask' resumes in full, as before v0.8.
export function startsFresh(row, choice) {
  const how = choice || (config.chats.coldResume === 'fresh' ? 'fresh' : 'full');
  if (how !== 'fresh' || row.title === null) return false;
  return Date.now() - lastCacheUse(row) > CACHE_MS && bigChat(contextOf(row));
}

// The stored handoff, if it covers the chat's latest replies.
export const currentHandoff = (row) => row.handoff && (row.handoff_at || 0) >= (row.active_at || row.updated_at || 0) ? row.handoff : null;

// ---- Writing a handoff ------------------------------------------------------------

// While the cache is warm: the chat's own process writes it in a hidden turn (runner.handOff),
// then closes. The next resume starts from the entry before that turn, so the model never sees
// it. Closing waits for the process to exit first, so the transcript is complete when it's read.
export async function warmHandoff(runner) {
  let result = null;
  try {
    result = await runner.handOff();
  } catch (err) {
    console.error(`The handoff for chat ${runner.id} failed:`, err.message);
  }
  runner.close();
  await Promise.race([runner.done, new Promise((r) => setTimeout(r, 10_000).unref())]);
  if (!result) return;
  const at = sessionEntries(runner.session).find((e) => e.uuid === result.uuid)?.parentUuid || null;
  const cut = at ? JSON.stringify({ session: runner.session, at }) : null;
  if (result.text || cut) q.setHandoff.run(result.text || null, result.text ? Date.now() : null, cut, runner.id);
  if (result.text) console.log(`Chat ${runner.id} wrote its handoff while its history was still cached.`);
}

// After the cache has expired: Haiku writes it from the transcript's text alone (what was said,
// the tools used and the files they touched; tool output and thinking are left out), in a
// one-off session that isn't saved. Null if there was nothing to summarise or it failed.
export async function coldHandoff(row) {
  const text = reduceTranscript(await sessionMessages(sessionOf(row)));
  if (!text) return null;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 3 * 60 * 1000);
  let out = null;
  try {
    const prompt = `Write a handoff for continuing the conversation below in a fresh session: ${ASK} Reply with the handoff only.\n\n` +
      `<conversation>\n${text}\n</conversation>`;
    for await (const msg of query({ prompt, options: {
      model: 'haiku', cwd: config.paths.brainDir, settingSources: [], env: agentEnv(), tools: [], maxTurns: 1,
      persistSession: false, abortController,
      systemPrompt: 'You write handoff notes that let an assistant called Nova carry on a conversation with the user in a new session. ' +
        'Be specific and concrete: keep names, paths, numbers and decisions exactly as they appear.'
    } })) {
      if (msg.type === 'result') out = msg.subtype === 'success' ? String(msg.result || '').trim() || null : null;
    }
  } catch (err) {
    console.error(`Couldn't write a handoff for chat ${row.id} with Haiku:`, err.message);
  } finally { clearTimeout(timer); }
  // Dated at the chat's last reply rather than now: Haiku didn't touch the chat's cache.
  if (out) q.setHandoff.run(out, row.active_at || row.updated_at, row.handoff_cut, row.id);
  return out;
}

const MAX_CHARS = 300_000; // about 75k tokens: the most of a transcript Haiku is given

// What was said in a session, as plain text: the user's messages, Nova's replies, and a summary of
// the tools used and the files they touched. Very long ones keep the opening request and the end.
export function reduceTranscript(messages) {
  const lines = [], tools = new Map(), files = new Set();
  for (const m of messages) {
    const c = m.message?.content;
    if (m.parent_tool_use_id) continue;
    if (m.type === 'user' && !isToolResult(c)) {
      const text = typeof c === 'string' ? c : Array.isArray(c)
        ? c.filter((b) => b.type === 'text' && !b.text.startsWith('<voice-reply>')).map((b) => b.text).join('\n') : '';
      if (text.trim()) lines.push(`User: ${text.trim()}`);
    } else if (m.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text.trim()) lines.push(`Nova: ${b.text.trim()}`);
        if (b.type === 'tool_use') {
          tools.set(b.name, (tools.get(b.name) || 0) + 1);
          const p = b.input?.file_path || b.input?.notebook_path || b.input?.path;
          if (typeof p === 'string') files.add(p);
        }
      }
    }
  }
  if (!lines.length) return '';
  let text = lines.join('\n\n');
  if (text.length > MAX_CHARS) text = `${lines[0].slice(0, 4000)}\n\n[… the middle of the conversation is left out …]\n\n${text.slice(-(MAX_CHARS - 4100))}`;
  if (tools.size) text += `\n\nTools used: ${[...tools].map(([n, k]) => `${n} ×${k}`).join(', ')}`;
  if (files.size) text += `\nFiles touched: ${[...files].slice(-200).join(', ')}`;
  return text;
}
