// Drawers on narrow screens: the sidebar (the menu buttons) and the avatar panel (the header
// button). A tap outside an open drawer closes it. On touch screens a swipe in from the left
// edge opens the sidebar and one in from the right edge opens the avatar panel, while they're
// drawers; swiping an open drawer back towards its edge closes it.
import { $ } from '../lib/dom.js';
import { dragActive } from '../lib/drag.js';
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

// ---- Edge swipes ----------------------------------------------------------------
// The breakpoints match responsive.css. The edge strip is wide enough to start a swipe inside
// a phone's own back gesture area, which takes touches right at the edge.
const sideDrawer = matchMedia('(max-width: 760px)');
const presenceDrawer = matchMedia('(max-width: 1080px)');
const edgeWidth = () => Math.min(72, Math.max(36, innerWidth * 0.12));

// True if a touch starting at x would open a drawer, so other swipes there (the task board's)
// leave it alone.
export function fromEdge(x) {
  return (sideDrawer.matches && x <= edgeWidth()) || (presenceDrawer.matches && x >= innerWidth - edgeWidth());
}

let swipe = null;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  swipe = e.touches.length === 1 && !document.querySelector('dialog[open]') ? { x: t.clientX, y: t.clientY } : null;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!swipe || dragActive()) { swipe = null; return; }
  const t = e.changedTouches[0], { x } = swipe, dx = t.clientX - x, dy = t.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) < 50 || Math.abs(dx) < 2 * Math.abs(dy)) return;
  if (els.sidebar.classList.contains('open')) { if (dx < 0) els.sidebar.classList.remove('open'); return; }
  if (els.presence.classList.contains('open')) { if (dx > 0) setPresenceOpen(false); return; }
  if (dx > 0 && sideDrawer.matches && x <= edgeWidth()) els.sidebar.classList.add('open');
  else if (dx < 0 && presenceDrawer.matches && x >= innerWidth - edgeWidth()) setPresenceOpen(true);
}, { passive: true });
