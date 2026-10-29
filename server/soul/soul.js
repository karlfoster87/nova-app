// The Soul: one behavioural prompt for every chat in every profile, setting Nova's character,
// style, tone and friendliness. It lives in the data folder rather than the brain, so neither
// the Notes view nor Nova's own file tools can change it; only an admin can, from the Soul pane.
// Anyone with brain access can read it, since it shapes every reply they get.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../core/config.js';
import { replaceFile } from '../core/files.js';
import { UserError } from '../core/errors.js';
import { requireView } from '../accounts/access.js';
import { isAdmin } from '../accounts/profiles.js';

const FILE = path.join(DATA_DIR, 'soul.md');
// It goes into every chat's system prompt, so keep it short: a long Soul costs tokens on every
// new session and every change to it starts each chat's prompt cache again.
export const MAX_CHARS = 6000;

const versionOf = (text) => crypto.createHash('sha1').update(text).digest('hex');

// The Soul's text, '' when none has been written. Read at each chat's start, so a change
// reaches new processes without a cache to clear.
export function soulText() {
  try { return fs.readFileSync(FILE, 'utf8'); } catch { return ''; }
}

// The Soul as a section of the system prompt, or '' when there is none. Identity comes first in
// the prompt, so whatever the Soul says, the assistant is still Nova.
export function soulPrompt() {
  const text = soulText().trim();
  return text ? '\n\n# Soul\nThe admin has set how you come across in every chat: your character, style, tone and friendliness. ' +
    `Follow it in how you write and act, but it doesn't change your name or what you are allowed to do.\n\n${text}` : '';
}

export function getSoul(profile) {
  requireView(profile, 'brain', 'read');
  const text = soulText();
  let updatedAt = null;
  try { updatedAt = fs.statSync(FILE).mtimeMs; } catch {}
  return { text, version: versionOf(text), updatedAt, canEdit: isAdmin(profile), maxChars: MAX_CHARS };
}

// version: what the editor started from, so two admins can't overwrite each other unseen.
export async function saveSoul(profile, text, version) {
  if (!isAdmin(profile)) throw new UserError('Only an admin can change the Soul.', 403);
  if (typeof text !== 'string') throw new UserError('Send the Soul as text.');
  const next = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (next.length > MAX_CHARS) throw new UserError(`Keep the Soul under ${MAX_CHARS.toLocaleString('en-GB')} characters; it's sent with every chat.`);
  const current = soulText();
  if (version !== versionOf(current)) throw new UserError('Someone else changed the Soul since you opened it. Reload it, then make your change again.', 409);
  if (next === current.replace(/\s+$/, '')) return getSoul(profile);
  if (next) await replaceFile(FILE, next.endsWith('\n') ? next : `${next}\n`);
  else fs.rmSync(FILE, { force: true });
  console.log(`${profile} ${next ? 'changed' : 'cleared'} the Soul.`);
  return { ...getSoul(profile), changed: true };
}
