// Pop-up menu shared by the sidebar and the views. One menu is open at a time; arrow keys
// move, Esc closes and returns focus, clicking outside closes.
import { h } from '/render.js';

let menu = null;

export function closeMenu(returnFocus = true) {
  if (!menu) return;
  const { el, anchor } = menu;
  menu = null;
  el.remove();
  anchor.setAttribute('aria-expanded', 'false');
  if (returnFocus && anchor.isConnected) anchor.focus();
}

// items: { label, action, danger?, indent?, disabled?, hidden?, swatch? } or { heading }.
// swatch names a note colour to show beside the label. hidden items are left out, and so
// is a heading with no indented items under it, which keeps long menus short.
export function openMenu(anchor, items) {
  items = items.filter((i) => !i.hidden)
    .filter((i, n, all) => !i.heading || all[n + 1]?.indent);
  const wasOpen = menu?.anchor === anchor;
  closeMenu(false);
  if (wasOpen) return;
  const el = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (item.heading) { el.append(h('p', { class: 'menu-heading' }, item.heading)); continue; }
    const b = h('button', { type: 'button', role: 'menuitem', class: `menu-item${item.danger ? ' danger' : ''}${item.indent ? ' indent' : ''}`, disabled: item.disabled },
      item.swatch ? h('span', { class: `swatch note-${item.swatch}`, 'aria-hidden': 'true' }) : null, item.label);
    b.addEventListener('click', () => { closeMenu(false); item.action(); });
    el.append(b);
  }
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, hgt = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  el.style.top = `${r.bottom + hgt + 8 > innerHeight ? Math.max(8, r.top - hgt - 4) : r.bottom + 4}px`;
  anchor.setAttribute('aria-expanded', 'true');
  menu = { el, anchor };
  el.querySelector('button:not(:disabled)')?.focus();
  el.addEventListener('keydown', (e) => {
    const buttons = [...el.querySelectorAll('button:not(:disabled)')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    if (e.key === 'Tab') closeMenu(false);
  });
}

document.addEventListener('pointerdown', (e) => {
  if (menu && !menu.el.contains(e.target) && !menu.anchor.contains(e.target)) closeMenu(false);
});
window.addEventListener('resize', () => closeMenu(false));
// Anything scrolling underneath would leave the menu floating in the wrong place. A long
// menu scrolls itself, though, and that must not close it.
document.addEventListener('scroll', (e) => { if (menu && !menu.el.contains(e.target)) closeMenu(false); }, true);
