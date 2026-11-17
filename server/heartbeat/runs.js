// Running Heartbeat schedules. A tick every five seconds starts whatever is due. A tick is plain
// code and never calls Claude itself: it reads due schedules through an index, and the only
// model work is the run it starts. Ticks never overlap, at most heartbeat.maxConcurrent runs go at
// once across every profile, and a run is skipped (not queued) while Nova is signed out, the plan
// is nearly used up, or the same schedule's previous run is still going.
//
// A schedule with a check script runs it first (check.js): if it prints nothing there is nothing
// to do, and no model starts; what it prints goes to Nova with the prompt.
//
// A behind-the-scenes run is a fresh hidden chat (origin 'heartbeat', kept out of the chat list)
// whose runner is unattended: no prompts, and every tool call allowed (since 2026-11-17 the
// schedule's prompt is what limits a run). Nova ends it by recording the outcome, and a question
// only when it can't go on without the user, with record_thought; if it doesn't, the run writes a
// short entry itself. A question pushes an alert that opens the Train of Thought. A schedule with
// a target chat instead sends its prompt there as a message, like the user typing it, so that
// chat's usual approvals apply. A one-off schedule switches itself off once it has started.
import crypto from 'node:crypto';
import { deleteSession } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../core/config.js';
import { q } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { can } from '../accounts/access.js';
import { signedIn, planUsage } from '../claude/meta.js';
import { startBackground, existingRunner } from '../chat/runner.js';
import { ownedChat, sendMessage } from '../chat/chats.js';
import { recordThought, pruneThoughts } from '../thought/thoughts.js';
import { pushNotice } from '../push/notify.js';
import { nextRun, getSchedule, heartbeatChanged, resetSchedules } from './schedules.js';
import { runCheck } from './check.js';

const running = new Map(); // schedule id -> { chatId, startedAt, runner, stop }
export const isRunning = (id) => running.has(id);
export const isRunChat = (chatId) => [...running.values()].some((e) => e.chatId === chatId);

const stamp = (ms) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Why a due run shouldn't start now, or null.
function skipReason(row) {
  if (running.has(row.id)) return 'Skipped: the previous run was still going.';
  if (!can(row.profile, 'brain', 'edit')) return 'Skipped: this profile no longer has edit access to Core.';
  if (signedIn() === false) return 'Skipped: Nova isn\'t signed in to Claude.';
  const limit = Number(config.heartbeat.pauseAtUsage), used = planUsage();
  if (limit > 0 && used >= limit) return `Skipped: the plan was ${Math.round(used)}% used.`;
  return null;
}

// ---- The tick ------------------------------------------------------------------------

let ticking = false;
async function tick() {
  if (ticking || !config.heartbeat.enabled) return;
  ticking = true;
  try {
    const now = Date.now(), max = Math.max(1, Number(config.heartbeat.maxConcurrent) || 1);
    for (const row of q.dueHeartbeats.all(now)) {
      // A due run waits for a free place rather than being skipped; it stays due until then.
      if (running.size >= max && !running.has(row.id)) break;
      if (row.once_at) q.endOnce.run(row.id);
      else q.setHeartbeatNext.run(nextRun(row, now), row.id);
      const skip = skipReason(row);
      if (skip) { q.heartbeatRan.run(now, skip, null, 0, row.id); heartbeatChanged(row.profile); continue; }
      start(row).catch((err) => console.error(`The schedule "${row.name}" failed to run:`, err));
    }
  } catch (err) {
    console.error('The Heartbeat tick failed:', err);
  } finally { ticking = false; }
}

// Runs the check script, if there is one, then the schedule. found: what the script printed.
async function start(row) {
  let found = null;
  if (row.check_script) {
    running.set(row.id, { chatId: null, startedAt: Date.now(), stop: null });
    heartbeatChanged(row.profile);
    let check;
    try { check = await runCheck(row.check_script); } finally { running.delete(row.id); }
    if (check.error) {
      const status = `Failed: ${check.error}.`;
      recordThought(row.profile, { source: 'heartbeat', sourceId: row.id, summary: `A scheduled run didn't start: ${check.error}.` });
      q.heartbeatRan.run(Date.now(), status, null, 0, row.id);
      heartbeatChanged(row.profile);
      console.log(`Heartbeat: "${row.name}" for ${row.profile}: ${status}`);
      return;
    }
    if (!check.output) {
      q.heartbeatRan.run(Date.now(), 'Nothing to do: the check script found nothing.', null, 0, row.id);
      heartbeatChanged(row.profile);
      return;
    }
    found = check.output;
  }
  return row.target_chat ? runInChat(row, found) : runBehind(row, found);
}

// ---- Behind the scenes -----------------------------------------------------------------

// The run's first message. The fixed instructions for unattended runs are in the runner's system
// prompt (runner.js runNote); this says which schedule it is and what it asks for.
const runPrompt = (row, found) => `<heartbeat-run schedule="${row.name.replace(/"/g, '\'')}" id="${row.id}" at="${new Date().toISOString()}">\n` +
  `${row.prompt}\n</heartbeat-run>` + (found ? `\n<check-output>\n${found}\n</check-output>` : '');

async function runBehind(row, found) {
  const chatId = crypto.randomUUID(), startedAt = Date.now();
  q.addRunChat.run(chatId, row.profile, `${row.name} · ${stamp(startedAt)}`, row.model, row.effort, startedAt, startedAt, row.id);
  const bg = { scheduleId: row.id, name: row.name, recorded: 0, questions: [] };
  const entry = { chatId, startedAt, stop: null };
  running.set(row.id, entry);
  heartbeatChanged(row.profile);
  console.log(`Heartbeat: "${row.name}" started for ${row.profile}.`);
  let status = 'Finished', result = null, timer = null;
  try {
    const runner = startBackground({ id: chatId, profile: row.profile, model: row.model || undefined,
      effort: row.effort || config.heartbeat.effort || undefined, background: bg });
    entry.runner = runner;
    const minutes = Math.max(1, Number(config.heartbeat.maxRunMinutes) || 15);
    const outcome = await new Promise((resolve) => {
      bg.onResult = (msg) => resolve({ msg });
      entry.stop = () => resolve({ stopped: true });
      timer = setTimeout(() => resolve({ timeout: true }), minutes * 60 * 1000);
      runner.done.then(() => resolve({ closed: true }));
      runner.send(runPrompt(row, found), crypto.randomUUID());
    });
    if (outcome.msg) {
      result = outcome.msg.result || null;
      const sub = outcome.msg.subtype;
      status = !sub || sub === 'success' ? 'Finished' : `Stopped before finishing (${String(sub).replace(/_/g, ' ')}).`;
    } else {
      status = outcome.timeout ? `Stopped: it was still going after ${minutes} minutes.` : outcome.stopped ? 'Stopped by you.' : 'Stopped: the run\'s process ended.';
      await runner.interrupt();
    }
  } catch (err) {
    status = `Failed: ${err.message}`;
    console.error(`Heartbeat: "${row.name}" failed:`, err);
  } finally {
    entry.runner?.close(); // a failed run's Claude Code process must end too
    clearTimeout(timer);
    running.delete(row.id);
  }
  try { finishRun(row, chatId, bg, status, result); } catch (err) { console.error(`Heartbeat: couldn't record "${row.name}":`, err); }
}

// What a finished run leaves behind: its Thought entry, the schedule's last run, and an alert
// when it has a question for the user.
function finishRun(row, chatId, bg, status, result) {
  if (!bg.recorded) {
    recordThought(row.profile, { source: 'heartbeat', sourceId: row.id, chatId,
      summary: status === 'Finished' ? 'A scheduled run finished.' : `A scheduled run stopped early. ${status}`, detail: result });
  }
  q.heartbeatRan.run(Date.now(), status, chatId, 1, row.id);
  heartbeatChanged(row.profile);
  console.log(`Heartbeat: "${row.name}" for ${row.profile}: ${status}`);
  if (bg.questions.length) pushNotice(row.profile, { title: `${row.name}: Nova has a question`, body: bg.questions[0], route: 'thought' });
}

// ---- In a chat -----------------------------------------------------------------------

async function runInChat(row, found) {
  const chat = ownedChat(row.profile, row.target_chat);
  let status = 'Sent to its chat.';
  if (!chat) status = 'Skipped: its chat was deleted.';
  else if (existingRunner(row.profile, chat.id)?.busy) status = 'Skipped: Nova was busy in that chat.';
  else {
    try {
      await sendMessage(row.profile, chat, { text: `Heartbeat "${row.name}": ${row.prompt}${found ? `\n\nThe check script found:\n\`\`\`\n${found}\n\`\`\`` : ''}`, attachments: [], model: row.model || chat.model || undefined,
        effort: row.effort || chat.effort || undefined, clientId: null });
    } catch (err) {
      status = `Failed: ${err.message}`;
      if (!(err instanceof UserError)) console.error(`Heartbeat: "${row.name}" couldn't send to its chat:`, err);
    }
  }
  q.heartbeatRan.run(Date.now(), status, chat?.id || null, status === 'Sent to its chat.' ? 1 : 0, row.id);
  heartbeatChanged(row.profile);
}

// ---- From the pane ---------------------------------------------------------------------

// Run now: straight away, without moving the next scheduled run.
export function runNow(profile, id) {
  const row = getSchedule(profile, id);
  if (!can(profile, 'brain', 'edit')) throw new UserError('This profile can view the schedules but not run them. An admin can give it edit access in Settings, under Profiles.', 403);
  if (running.has(row.id)) throw new UserError('It\'s running now. Wait for it to finish, or stop it.', 409);
  if (signedIn() === false) throw new UserError('Nova isn\'t signed in to Claude. Sign in from Settings, Claude, then try again.', 409);
  start(row).catch((err) => console.error(`The schedule "${row.name}" failed to run:`, err));
  return { started: true };
}

export function stopRun(profile, id) {
  const row = getSchedule(profile, id);
  if (!can(profile, 'brain', 'edit')) throw new UserError('This profile can view the schedules but not stop them.', 403);
  const entry = running.get(row.id);
  if (!entry) throw new UserError('It isn\'t running.', 409);
  entry.stop?.();
  return { stopping: true };
}

// ---- Keeping it tidy -----------------------------------------------------------------

// Behind-the-scenes runs older than heartbeat.keepRunsDays leave the database and Claude Code's
// session files; their Thought entries stay (and no longer link anywhere).
async function pruneRuns() {
  const days = Number(config.heartbeat.keepRunsDays);
  if (days > 0) {
    const active = new Set([...running.values()].map((e) => e.chatId));
    for (const r of q.oldRunChats.all(Date.now() - days * 24 * 60 * 60 * 1000)) {
      if (active.has(r.id)) continue;
      q.deleteChat.run(r.id, r.profile);
      await deleteSession(r.id, { dir: config.paths.brainDir }).catch(() => {});
    }
  }
  pruneThoughts();
}

export function startHeartbeats() {
  resetSchedules();
  setInterval(tick, 5000).unref();
  setTimeout(() => pruneRuns().catch((err) => console.error('Tidying Heartbeat runs failed:', err)), 60 * 1000).unref();
  setInterval(() => pruneRuns().catch((err) => console.error('Tidying Heartbeat runs failed:', err)), 6 * 60 * 60 * 1000).unref();
}
