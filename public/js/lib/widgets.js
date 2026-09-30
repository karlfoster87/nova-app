// Small pieces of UI used in several places: a profile's picture circle and a file capsule.
import { h } from './dom.js';
import { fileSize } from './format.js';

// A profile's circle: its picture if it has one, otherwise its first letter.
// `stamp` is the picture's updated_at, which also makes a changed picture load again.
export const pictureUrl = (name, stamp) => `/api/profiles/${encodeURIComponent(name)}/picture?v=${stamp}`;
export function fillCircle(el, name, stamp) {
  el.replaceChildren(stamp ? h('img', { class: 'picture', src: pictureUrl(name, stamp), alt: '' }) : name.charAt(0).toUpperCase());
  return el;
}
export const profileCircle = (name, stamp) => fillCircle(h('span', { class: 'profile-circle', 'aria-hidden': 'true' }), name, stamp);

// Attachment types the server serves inline, so their capsule opens rather than downloads.
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// One attached file as a capsule, in the composer and in sent messages. f: { id?, name,
// size (bytes) or sizeText, type? }. href links it (images open, other files download);
// progress (0 to 1) shows an upload under way; error replaces the size; onRemove adds ×.
export function fileChip(f, { href, progress = null, error = null, onRemove = null } = {}) {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(f.name)?.[1] || 'file').toUpperCase();
  const image = INLINE_IMAGES.has(f.type);
  const name = href
    ? h('a', { class: 'file-name', href, title: f.name, target: image ? '_blank' : null, rel: image ? 'noopener' : null, download: image ? null : f.name }, f.name)
    : h('span', { class: 'file-name', title: f.name }, f.name);
  const detail = error || (progress != null ? `${Math.round(progress * 100)}%` : typeof f.size === 'number' ? fileSize(f.size) : f.sizeText || '');
  const chip = h('li', { class: `file-chip${error ? ' error' : ''}${progress != null ? ' busy' : ''}` },
    h('span', { class: 'file-ext', 'aria-hidden': 'true' }, ext), name, h('span', { class: 'file-size' }, detail));
  if (progress != null) chip.style.setProperty('--progress', `${Math.round(progress * 100)}%`);
  if (onRemove) chip.append(h('button', { type: 'button', class: 'file-remove', title: 'Remove', 'aria-label': `Remove ${f.name}`, onclick: onRemove }, '×'));
  return chip;
}
