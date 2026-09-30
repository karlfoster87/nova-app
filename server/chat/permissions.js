// Per-profile remembered approvals and extra folders. Both live in
// nova.db, never in the brain's shared .claude settings, except when an admin explicitly
// shares a rule with every profile.
import fs from 'node:fs';
import path from 'node:path';
import { q } from '../core/db.js';
import { config } from '../core/config.js';
import { UserError } from '../core/errors.js';
import { fold, within } from '../core/paths.js';
import { replaceFile } from '../core/files.js';

// ---- Approvals --------------------------------------------------------------

// A rule as Claude Code writes it in settings files: Tool, or Tool(content) with any
// backslash or parenthesis in the content escaped.
const ruleText = (tool, rule) => rule ? `${tool}(${rule.replace(/[\\()]/g, '\\$&')})` : tool;

// What a permission request can be remembered as. Only when every suggestion Claude Code
// made is an allow rule, so storing them covers exactly what it asked about and a later
// request with the same suggestions is known to be covered.
export function rememberableRules(toolName, suggestions) {
  if (toolName === 'AskUserQuestion' || !suggestions?.length) return null;
  if (!suggestions.every((s) => s.type === 'addRules' && s.behavior === 'allow' && s.rules?.length)) return null;
  return suggestions.flatMap((s) => s.rules).map((r) => ({ tool: String(r.toolName), rule: String(r.ruleContent || '') }));
}

export const isApproved = (profile, rules) => rules.every((r) => q.approval.get(profile, r.tool, r.rule));

export function remember(profile, rules) {
  for (const r of rules) q.addApproval.run(profile, r.tool, r.rule, Date.now());
}

// The same rules for this Claude Code session only, so it stops asking without any
// settings file being written.
export const sessionRules = (rules) => [{
  type: 'addRules', behavior: 'allow', destination: 'session',
  rules: rules.map((r) => (r.rule ? { toolName: r.tool, ruleContent: r.rule } : { toolName: r.tool }))
}];

export function listApprovals(profile) {
  return q.approvals.all(profile).map((a) => ({ tool: a.tool, rule: a.rule, text: ruleText(a.tool, a.rule), createdAt: a.created_at }));
}

export function forgetApproval(profile, tool, rule) {
  if (!q.deleteApproval.run(profile, String(tool), String(rule || '')).changes) throw new UserError('That approval isn\'t stored any more.', 404);
}

// Moves one of the profile's rules into <brainDir>/.claude/settings.local.json, which every
// profile's chats load. Written atomically; refuses rather than overwrite a file it can't parse.
export async function shareApproval(profile, tool, rule) {
  tool = String(tool); rule = String(rule || '');
  if (!q.approval.get(profile, tool, rule)) throw new UserError('That approval isn\'t stored any more.', 404);
  const dir = path.join(config.paths.brainDir, '.claude');
  const file = path.join(dir, 'settings.local.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new UserError(`${file} isn't valid JSON, so Nova won't change it. Fix or remove it, then try again.`, 409); }
  }
  const text = ruleText(tool, rule);
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  if (!settings.permissions.allow.includes(text)) settings.permissions.allow.push(text);
  fs.mkdirSync(dir, { recursive: true });
  await replaceFile(file, JSON.stringify(settings, null, 2) + '\n');
  q.deleteApproval.run(profile, tool, rule);
  console.log(`${profile} shared the rule ${text} with all profiles in ${file}.`);
  return { text, file };
}

// ---- Folders ----------------------------------------------------------------

export const listFolders = (profile) => q.folders.all(profile).map((f) => ({ path: f.path, createdAt: f.created_at }));
export const folderPaths = (profile) => q.folders.all(profile).map((f) => f.path);

// Checks a folder the service account can actually list, and returns its real spelling.
function checkFolder(profile, input) {
  const raw = String(input || '').trim();
  const example = process.platform === 'win32' ? 'D:\\Projects or \\\\server\\share\\folder' : '/mnt/share/projects';
  if (!raw) throw new UserError('Enter the full path of a folder.');
  if (!path.isAbsolute(raw)) throw new UserError(`Use a full path, e.g. ${example}.`);
  let stat;
  try { stat = fs.statSync(raw); } catch {
    throw new UserError(`${raw} doesn't exist, or Nova can't see it.` + (process.platform === 'win32'
      ? ' Mapped drive letters belong to one Windows sign-in, so if Nova runs as a service, use the \\\\server\\share path instead.' : ''));
  }
  if (!stat.isDirectory()) throw new UserError(`${raw} is a file, not a folder.`);
  const dir = fs.realpathSync.native(raw);
  try { fs.readdirSync(dir); } catch { throw new UserError(`Nova can't read ${dir}. Check the folder's permissions for the account running Nova.`); }
  if (within(dir, config.paths.brainDir)) throw new UserError(`${dir} is inside the brain folder, which chats can already use.`);
  const covering = folderPaths(profile).find((f) => within(dir, f));
  if (covering) throw new UserError(fold(covering) === fold(dir) ? 'That folder is already on your list.' : `${dir} is already covered by ${covering}.`);
  return dir;
}

export function addFolder(profile, input) {
  const dir = checkFolder(profile, input);
  q.addFolder.run(profile, dir, Date.now());
  return dir;
}

export function removeFolder(profile, dir) {
  if (!q.deleteFolder.run(profile, String(dir)).changes) throw new UserError('That folder isn\'t on your list any more.', 404);
}

// The folder to offer for a blocked path: the path itself if it's a folder, otherwise the
// nearest folder above it that exists (a file Claude wants to create doesn't exist yet).
export function folderFor(blockedPath) {
  if (!blockedPath || !path.isAbsolute(blockedPath)) return null;
  let p = path.resolve(blockedPath);
  for (;;) {
    try { if (fs.statSync(p).isDirectory()) return fs.realpathSync.native(p); } catch {}
    const up = path.dirname(p);
    if (up === p) return null;
    p = up;
  }
}
