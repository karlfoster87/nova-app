// Drawers on narrow screens: the sidebar (the menu buttons) and the avatar panel (the header
// button). A tap outside an open drawer closes it.
import { $ } from '../lib/dom.js';
import { els } from '../state.js';

const presenceBtn = $('presenceBtn');
function setPresenceOpen(open) {
  els.presence.classList.toggle('open', open);
  presenceBtn.setAttribute('aria-expanded', String(open));
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.menu-btn')) els.sidebar.classList.toggle('open');
  if (e.target.closest('#presenceBtn')) setPresenceOpen(!els.presence.classList.contains('open'));
});
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.menu-btn, #presenceBtn, .menu, dialog')) return;
  if (els.sidebar.classList.contains('open') && !els.sidebar.contains(e.target)) els.sidebar.classList.remove('open');
  if (els.presence.classList.contains('open') && !els.presence.contains(e.target)) setPresenceOpen(false);
});
