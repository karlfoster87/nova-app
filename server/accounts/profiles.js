// Profile management: create, list, edit, rename, delete. Admins manage every profile
// and the global settings; users can only edit their own profile.
import fs from 'node:fs';
import { q, transaction } from './db.js';
import { hashSecret, verifySecret } from './auth.js';
import { profileDir, profileDirPath } from './config.js';
import { hub } from './hub.js';
import { runnersOf, busyRunners } from './chat.js';
import { UserError } from './errors.js';
import { accessFor, mergeAccess } from './access.js';
import { moveProfileUploads } from './uploads.js';

export const ROLES = ['admin', 'user'];
// Names keep the case they were typed in but are unique ignoring case, so "Sam" and
// "sam" are the same profile (q.profile matches with COLLATE NOCASE).
const NAME_RE = /^[A-Za-z0-9-]{2,32}$/;
const PIN_RE = /^\d{4}$/; // the switcher has four boxes; the sign-in throttle keeps 4 digits safe

export class ProfileError extends UserError {}

// Personal preferences a profile sets for itself, with their defaults. Each key's default
// also fixes its type; add new ones here.
const PREFS = { hideWeekends: false };

export function prefsFor(row) {
  let stored = {};
  try { stored = JSON.parse(row?.prefs || '{}') || {}; } catch {}
  return Object.fromEntries(Object.entries(PREFS).map(([k, d]) => [k, typeof stored[k] === typeof d ? stored[k] : d]));
}

function mergePrefs(row, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ProfileError('Send preferences as { name: value }.');
  const next = prefsFor(row);
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in PREFS)) throw new ProfileError(`There's no "${k}" preference.`);
    if (typeof v !== typeof PREFS[k]) throw new ProfileError(`"${k}" must be ${typeof PREFS[k] === 'boolean' ? 'true or false' : `a ${typeof PREFS[k]}`}.`);
    next[k] = v;
  }
  return JSON.stringify(next);
}

export function isAdmin(name) { return q.profile.get(name)?.role === 'admin'; }

function checkName(name) {
  if (!NAME_RE.test(name)) throw new ProfileError('Use 2 to 32 letters, digits or hyphens for the profile name.');
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 12) throw new ProfileError('Passwords need at least 12 characters.');
}
function checkPin(pin) {
  if (!PIN_RE.test(pin)) throw new ProfileError('A PIN is exactly 4 digits.');
}

// Everyone sees profile names and whether each has a PIN, so they can switch.
// Admins also see roles, dates and chat counts for managing them.
export function listProfiles(viewer) {
  const admin = isAdmin(viewer);
  return q.profiles.all().map((p) => admin
    ? { name: p.name, role: p.role, hasPin: !!p.has_pin, picture: p.picture, createdAt: p.created_at, chatCount: p.chat_count, current: p.name === viewer,
      access: accessFor(p.name, { asUser: true }) }
    : { name: p.name, hasPin: !!p.has_pin, picture: p.picture, current: p.name === viewer });
}

// Profile pictures. The browser has already cropped and scaled them; the type
// comes from the file's first bytes, never from what the browser says it is.
const PICTURE_MAX = 512 * 1024;
function pictureType(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  return null;
}

// Self, or an admin for anyone; returns the stored spelling of the name.
function pictureTarget(actor, target) {
  const row = q.profile.get(target);
  if (!row) throw new ProfileError('That profile doesn\'t exist.', 404);
  if (row.name !== actor && !isAdmin(actor)) throw new ProfileError('You can only change your own picture.', 403);
  return row.name;
}

export function setPicture(actor, target, buf) {
  const name = pictureTarget(actor, target);
  if (buf.length > PICTURE_MAX) throw new ProfileError('That picture is too big. Choose a smaller one.', 413);
  const type = pictureType(buf);
  if (!type) throw new ProfileError('Use a PNG, JPEG, WebP or GIF picture.', 415);
  const at = Date.now();
  q.setPicture.run(name, type, buf, at);
  hub.toProfile(name, { t: 'profile_changed' }); // its tabs redraw the sidebar picture
  return at;
}

export function removePicture(actor, target) {
  const name = pictureTarget(actor, target);
  q.deletePicture.run(name);
  hub.toProfile(name, { t: 'profile_changed' });
}

export function readPicture(target) {
  const row = q.profile.get(target);
  return row ? q.picture.get(row.name) : undefined;
}

export const pictureStamp = (name) => q.pictureStamp.get(name)?.updated_at ?? null;

export function createProfile({ name, password, role = 'user', pin }) {
  name = String(name || '').trim();
  checkName(name);
  const clash = q.profile.get(name);
  if (clash) throw new ProfileError(`A profile called "${clash.name}" already exists.`);
  checkPassword(password);
  if (!ROLES.includes(role)) throw new ProfileError('Choose admin or user for the role.');
  if (pin) checkPin(pin);
  q.addProfile.run(name, hashSecret(password), Date.now(), role, pin ? hashSecret(pin) : null);
  profileDir(name);
  return name;
}

// actor edits target. Users may only edit themselves, and must confirm their current
// password to change their own password or PIN. Admins may edit anyone; the last admin
// can't be demoted.
export function updateProfile(actor, target, body) {
  const actorIsAdmin = isAdmin(actor);
  const row = q.profile.get(target);
  if (!row && !actorIsAdmin) throw new ProfileError('You can only change your own profile.', 403);
  if (!row) throw new ProfileError('That profile doesn\'t exist.', 404);
  target = row.name; // the stored spelling, whatever case the URL used
  const self = actor === target;
  if (!self && !actorIsAdmin) throw new ProfileError('You can only change your own profile.', 403);

  const needsCurrent = self && ('password' in body || 'pin' in body);
  if (needsCurrent && !verifySecret(String(body.currentPassword || ''), row.pass_hash)) {
    throw new ProfileError('Your current password is incorrect.', 403);
  }

  // Validate everything before changing anything, so a refusal never leaves a half-applied edit.
  const roleChange = 'role' in body && body.role !== row.role;
  if (roleChange) {
    if (!actorIsAdmin) throw new ProfileError('Only an admin can change roles.', 403);
    if (!ROLES.includes(body.role)) throw new ProfileError('Choose admin or user for the role.');
    if (row.role === 'admin' && q.adminCount.get().n <= 1) throw new ProfileError('Keep at least one admin. Make another profile admin first.');
  }
  let access = null;
  if ('access' in body) {
    if (!actorIsAdmin) throw new ProfileError('Only an admin can change what a profile can use.', 403);
    access = mergeAccess(row, body.access);
  }
  const prefs = 'prefs' in body ? mergePrefs(row, body.prefs) : null; // self, or an admin
  if ('password' in body) checkPassword(body.password);
  const clearPin = 'pin' in body && (body.pin === null || body.pin === '');
  if ('pin' in body && !clearPin) checkPin(String(body.pin));

  let name = target;
  if ('name' in body && String(body.name).trim() !== target) name = renameProfile(target, body.name);
  if (access !== null) q.setAccess.run(access, name);
  if (prefs !== null) q.setPrefs.run(prefs, name);
  if (roleChange) q.setRole.run(body.role, name);
  if (roleChange || access !== null || prefs !== null) hub.toProfile(name, { t: 'profile_changed' }); // its tabs refresh what they show
  if ('password' in body) q.setPassword.run(hashSecret(body.password), name);
  if ('pin' in body) q.setPin.run(clearPin ? null : hashSecret(String(body.pin)), name);
  return name;
}

// Renaming touches the database, the notes folder and any open chats, so it refuses
// while that profile has chats working and does the folder first so it can roll back.
function renameProfile(oldName, newName) {
  newName = String(newName || '').trim();
  checkName(newName);
  const clash = q.profile.get(newName);
  if (clash && clash.name !== oldName) throw new ProfileError(`A profile called "${clash.name}" already exists.`);
  const caseOnly = newName.toLowerCase() === oldName.toLowerCase();
  const runners = runnersOf(oldName);
  if (runners.some((r) => busyRunners().includes(r))) {
    throw new ProfileError('This profile has a chat still working. Stop it or wait, then rename.', 409);
  }

  const oldDir = profileDirPath(oldName);
  const newDir = profileDirPath(newName);
  const moveDir = fs.existsSync(oldDir);
  if (moveDir && !caseOnly && fs.existsSync(newDir)) {
    throw new ProfileError(`The profiles folder already has a "${newName}" folder. Move or rename it first.`, 409);
  }
  if (moveDir) {
    try { moveFolder(oldDir, newDir, caseOnly); } catch (err) {
      console.error('Profile folder rename failed:', err);
      throw new ProfileError(`Couldn't rename the notes folder ${oldDir}. Close anything using it and try again.`, 409);
    }
  }
  try {
    transaction(() => {
      q.renameProfile.run(newName, oldName);
      q.renameProfileLogins.run(newName, oldName);
      q.renameProfileChats.run(newName, oldName);
      q.renameProfileCategories.run(newName, oldName);
      q.renameProfileApprovals.run(newName, oldName);
      q.renameProfileFolders.run(newName, oldName);
      q.renameProfileTasks.run(newName, oldName);
      q.renameProfileNotes.run(newName, oldName);
      q.renameProfileUploads.run(newName, oldName);
      q.renameProfilePicture.run(newName, oldName);
    });
    moveProfileUploads(oldName, newName);
  } catch (err) {
    if (moveDir) moveFolder(newDir, oldDir, caseOnly);
    throw err;
  }
  for (const r of runners) r.close(); // they captured the old name and folder
  hub.disconnect(oldName, { t: 'reload' });
  return newName;
}

// Case-insensitive file systems (Windows, macOS) can refuse a rename that only changes
// case, so those go through a temporary name.
function moveFolder(from, to, caseOnly) {
  if (!caseOnly) return fs.renameSync(from, to);
  const temp = `${from}.renaming-${Date.now()}`;
  fs.renameSync(from, temp);
  fs.renameSync(temp, to);
}

// Removes the profile, its sessions, chat list, approvals, folders, tasks and notes. Transcripts and the notes folder
// stay on disk, the same as deleting a single chat.
export function deleteProfile(actor, target) {
  if (!isAdmin(actor)) throw new ProfileError('Only an admin can remove profiles.', 403);
  const row = q.profile.get(target);
  if (!row) throw new ProfileError('That profile doesn\'t exist.', 404);
  target = row.name;
  if (actor === target) throw new ProfileError('You can\'t remove the profile you\'re signed in to. Switch to another admin first.', 409);
  if (row.role === 'admin' && q.adminCount.get().n <= 1) throw new ProfileError('Keep at least one admin.');
  for (const r of runnersOf(target)) r.close();
  transaction(() => {
    q.deleteProfileChats.run(target);
    q.deleteProfileCategories.run(target);
    q.deleteProfileApprovals.run(target);
    q.deleteProfileFolders.run(target);
    q.deleteProfileTasks.run(target);
    q.deleteProfileNotes.run(target);
    q.deleteProfileUploads.run(target); // the files stay on disk, like transcripts
    q.deletePicture.run(target);
    q.deleteProfileLogins.run(target);
    q.deleteProfile.run(target);
  });
  hub.disconnect(target, { t: 'reload' });
}
