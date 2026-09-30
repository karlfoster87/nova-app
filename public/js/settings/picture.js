// Profile pictures, in Your profile and in an admin's profile editor. Pictures are cropped to a
// centred square and scaled to 256px here, so uploads stay small and any photo works; the
// server still checks what arrives. WebP where the browser can make it, PNG otherwise.
import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { profileCircle } from '../lib/widgets.js';
import { run } from './forms.js';

async function squarePicture(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('Nova can\'t read that picture. Use a PNG, JPEG, WebP or GIF.'); }
  const side = Math.min(bmp.width, bmp.height), size = Math.min(256, side);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  bmp.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  if (!blob) throw new Error('Nova couldn\'t prepare that picture. Try another one.');
  return blob;
}

// The body is the image itself, so this can't go through api(), which sends JSON.
async function uploadPicture(name, file) {
  const blob = await squarePicture(file);
  const res = await fetch(`/api/profiles/${encodeURIComponent(name)}/picture`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The picture didn't upload (${res.status}). Try again.`);
  return data.picture;
}

// A profile's circle with Choose a picture and Remove picture. The outcome shows in `form`'s
// status line; `after(stamp, message)` redraws whatever shows the picture and returns the message.
export function pictureControls(name, stamp, form, after) {
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
  const choose = h('button', { type: 'button', class: 'text-btn', onclick: () => file.click() }, stamp ? 'Change picture' : 'Choose a picture');
  const remove = stamp ? h('button', { type: 'button', class: 'text-btn' }, 'Remove picture') : null;
  file.addEventListener('change', () => {
    const picked = file.files[0];
    file.value = '';
    if (picked) run(form, async () => after(await uploadPicture(name, picked), 'Picture saved.'));
  });
  remove?.addEventListener('click', () => run(form, async () => {
    await api('DELETE', `/api/profiles/${encodeURIComponent(name)}/picture`);
    return after(null, 'Picture removed.');
  }));
  return h('div', { class: 'picture-row' }, profileCircle(name, stamp), choose, remove, file);
}
