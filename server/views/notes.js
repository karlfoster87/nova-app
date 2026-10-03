// Notes view: per-profile sticky notes with text, a colour from a fixed
// palette, and a manual order.
// A note can be shared ("Show to everyone"): it then appears in every profile's Notes view,
// in a section of its own with one order for everyone, and anyone with edit access can change
// or delete it. Only the profile that shared it can stop sharing it. This is the one place a
// row is reached by another profile, so every lookup goes through noteFor, which allows a
// foreign note only while it's shared.
import crypto from 'node:crypto';
import { q, transaction, reorder } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { requireView } from '../accounts/access.js';

// The palette names; public/css/tokens.css gives each a light and a dark colour (--note-*).
const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'grey'];

// The profile's own note, or a shared one. Anything else is "doesn't exist", so ids can't be probed.
function noteFor(profile, id) {
  const row = id ? q.note.get(String(id)) : null;
  if (!row || (row.profile !== profile && !row.shared)) throw new UserError('That note doesn\'t exist any more.', 404);
  return row;
}

// A shared note changed (or stopped being shared): every profile's views should reload.
export function isSharedNote(id) {
  const row = id ? q.note.get(String(id)) : null;
  return Boolean(row?.shared);
}

function checkText(text) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n');
  if (t.length > 10000) throw new UserError('Keep a note to 10,000 characters or fewer.');
  return t;
}

function checkColor(color) {
  if (!COLORS.includes(color)) throw new UserError('Pick one of the note colours.');
  return color;
}

// active false = a long-standing note: shown apart and left out of the count. shared notes
// say who shared them (owner) and whether that's this profile (mine).
const shapeFor = (profile) => (r) => ({ id: r.id, text: r.text, color: r.color, active: r.active !== 0, shared: r.shared === 1,
  owner: r.profile, mine: r.profile === profile, position: r.position, createdAt: r.created_at, updatedAt: r.updated_at });

// Only the profile's own active notes count; shared ones belong to everyone.
export const activeNoteCount = (profile) => Number(q.activeNotes.get(profile).n);

// The profile's own notes, then every shared note.
export function listNotes(profile) {
  requireView(profile, 'notes', 'read');
  const shape = shapeFor(profile);
  return [...q.notes.all(profile).map(shape), ...q.sharedNotes.all().map(shape)];
}

// New notes go first, where they're easiest to find.
export function createNote(profile, { text = '', color = 'yellow' } = {}) {
  requireView(profile, 'notes', 'edit');
  const id = crypto.randomUUID(), now = Date.now();
  q.addNote.run(id, profile, checkText(text), checkColor(color), q.firstNotePosition.get(profile).n, now, now);
  return shapeFor(profile)(q.note.get(id));
}

// shared: true shows the note to every profile (first in the shared section), false takes it
// back to the owner's own notes (first there). Only the owner may change it.
export function updateNote(profile, id, body) {
  requireView(profile, 'notes', 'edit');
  const row = noteFor(profile, id);
  const text = 'text' in body ? checkText(body.text) : row.text;
  const color = 'color' in body ? checkColor(body.color) : row.color;
  if ('active' in body && typeof body.active !== 'boolean') throw new UserError('Mark a note as active or long-standing.');
  const active = 'active' in body ? Number(body.active) : row.active;
  if ('shared' in body && typeof body.shared !== 'boolean') throw new UserError('Choose whether to show the note to everyone.');
  const shared = 'shared' in body ? Number(body.shared) : row.shared;
  if (shared !== row.shared && row.profile !== profile) {
    throw new UserError(`Only ${row.profile}, who shared this note, can stop showing it to everyone.`, 403);
  }
  const now = Date.now();
  transaction(() => {
    q.updateNote.run(text, color, active, now, row.id, row.profile);
    if (shared !== row.shared) {
      const position = shared ? q.firstSharedPosition.get().n : q.firstNotePosition.get(row.profile).n;
      q.setNoteShared.run(shared, position, now, row.id, row.profile);
    }
  });
  return shapeFor(profile)(q.note.get(row.id));
}

// Puts a note before beforeId, or last, and renumbers the rest of its list: the profile's own
// notes, or the shared ones (one order for everyone).
export function moveNote(profile, id, { beforeId = null } = {}) {
  requireView(profile, 'notes', 'edit');
  const row = noteFor(profile, id);
  transaction(() => {
    if (row.shared) {
      reorder(q.sharedNotes.all().map((n) => n.id), row.id, beforeId, (i, n) => q.setSharedNotePosition.run(i, n));
    } else {
      reorder(q.notes.all(profile).map((n) => n.id), row.id, beforeId, (i, n) => q.setNotePosition.run(i, n, profile));
    }
  });
  return listNotes(profile);
}

export function deleteNote(profile, id) {
  requireView(profile, 'notes', 'edit');
  const row = noteFor(profile, id);
  q.deleteNote.run(row.id, row.profile);
}
