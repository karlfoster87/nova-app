// Notes view: per-profile sticky notes with text, a colour from a fixed
// palette, and a manual order.
import crypto from 'node:crypto';
import { q, transaction, reorder } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { requireView } from '../accounts/access.js';

// The palette names; public/css/tokens.css gives each a light and a dark colour (--note-*).
const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'grey'];

function ownedNote(profile, id) {
  const row = id ? q.note.get(String(id)) : null;
  if (!row || row.profile !== profile) throw new UserError('That note doesn\'t exist any more.', 404);
  return row;
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

// active false = a long-standing note: shown apart and left out of the count.
const shape = (r) => ({ id: r.id, text: r.text, color: r.color, active: r.active !== 0, position: r.position, createdAt: r.created_at, updatedAt: r.updated_at });

export const activeNoteCount = (profile) => Number(q.activeNotes.get(profile).n);

export function listNotes(profile) {
  requireView(profile, 'notes', 'read');
  return q.notes.all(profile).map(shape);
}

// New notes go first, where they're easiest to find.
export function createNote(profile, { text = '', color = 'yellow' } = {}) {
  requireView(profile, 'notes', 'edit');
  const id = crypto.randomUUID(), now = Date.now();
  q.addNote.run(id, profile, checkText(text), checkColor(color), q.firstNotePosition.get(profile).n, now, now);
  return shape(q.note.get(id));
}

export function updateNote(profile, id, body) {
  requireView(profile, 'notes', 'edit');
  const row = ownedNote(profile, id);
  const text = 'text' in body ? checkText(body.text) : row.text;
  const color = 'color' in body ? checkColor(body.color) : row.color;
  if ('active' in body && typeof body.active !== 'boolean') throw new UserError('Mark a note as active or long-standing.');
  const active = 'active' in body ? Number(body.active) : row.active;
  q.updateNote.run(text, color, active, Date.now(), row.id, profile);
  return shape(q.note.get(row.id));
}

// Puts a note before beforeId, or last, and renumbers the rest.
export function moveNote(profile, id, { beforeId = null } = {}) {
  requireView(profile, 'notes', 'edit');
  const row = ownedNote(profile, id);
  transaction(() => reorder(q.notes.all(profile).map((n) => n.id), row.id, beforeId,
    (i, n) => q.setNotePosition.run(i, n, profile)));
  return listNotes(profile);
}

export function deleteNote(profile, id) {
  requireView(profile, 'notes', 'edit');
  const row = ownedNote(profile, id);
  q.deleteNote.run(row.id, profile);
}
