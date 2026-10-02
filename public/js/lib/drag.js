// Dragging cards to reorder them (Tasks and Notes), with the mouse, a pen or a finger.
// It's built on pointer events rather than the browser's own drag and drop, so the whole card
// can be picked up (buttons and the click-to-edit title included) and it works the same on
// touch screens. A mouse drag starts once the pointer moves a few pixels, so a click without
// movement is still a click; a finger has to hold still briefly first, so a swipe still
// scrolls. The click that would follow a drag is swallowed. While dragging, a copy of the card
// follows the pointer and the view is told what's under it; lists scroll near their edges.
// The view decides what a position means and shows its own drop marks.

const MOUSE_SLOP = 5;   // px a mouse moves before a press becomes a drag
const TOUCH_SLOP = 8;   // px a finger may wander while holding
const HOLD_MS = 350;    // how long a finger holds before the card lifts
const EDGE = 48;        // px from a scrolling list's edge where it starts to scroll
const NO_DRAG = 'input, textarea, select, a, [contenteditable="true"], .no-drag';

let active = null;      // the drag in progress
let endedAt = 0;        // when the last drag ended, so swipes that were really drags are ignored
let claimed = null;     // the pointerdown a nested card has already taken

// True during a drag and just after it, for gestures that would otherwise act on the same touch.
export const dragActive = () => !!active || performance.now() - endedAt < 400;

// A finger that has lifted a card mustn't scroll the page as it moves.
document.addEventListener('touchmove', (e) => { if (active) e.preventDefault(); }, { passive: false });

// el: the card. opts:
//   canStart(e)        false to leave this press alone (e.g. while editing)
//   start()            the drag began
//   move(x, y, under)  the pointer is over `under` (the card copy never counts)
//   drop(x, y, under)  released there
//   end(dropped)       always last, after drop or a cancel (Esc, or the browser taking the touch)
export function draggable(el, opts) {
  el.addEventListener('dragstart', (e) => e.preventDefault()); // no native drag of images or text
  el.addEventListener('contextmenu', (e) => { if (active || pending?.touch) e.preventDefault(); });
  let pending = null;
  el.addEventListener('pointerdown', (e) => {
    if (claimed === e || active || !e.isPrimary || e.button !== 0) return;
    if (e.target.closest(NO_DRAG) || opts.canStart?.(e) === false) return;
    claimed = e; // a subtask's press isn't also its parent's
    const touch = e.pointerType === 'touch';
    pending = { x: e.clientX, y: e.clientY, touch, id: e.pointerId };
    if (touch) pending.timer = setTimeout(() => { const p = pending; pending = null; quit(); begin(el, opts, p.x, p.y, p.lx ?? p.x, p.ly ?? p.y); }, HOLD_MS);
    const onMove = (m) => {
      if (!pending || m.pointerId !== pending.id) return;
      const dist = Math.hypot(m.clientX - pending.x, m.clientY - pending.y);
      if (touch) { pending.lx = m.clientX; pending.ly = m.clientY; if (dist > TOUCH_SLOP) cancel(); return; }
      if (dist > MOUSE_SLOP) { const p = pending; pending = null; quit(); begin(el, opts, p.x, p.y, m.clientX, m.clientY); }
    };
    const cancel = () => { clearTimeout(pending?.timer); pending = null; quit(); };
    const quit = () => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', cancel);
      removeEventListener('pointercancel', cancel);
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', cancel);
    addEventListener('pointercancel', cancel);
  });
}

function begin(el, opts, x0, y0, x, y) {
  const r = el.getBoundingClientRect();
  const ghost = el.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.removeAttribute('id');
  ghost.setAttribute('aria-hidden', 'true');
  // Set here rather than in CSS: the card's own class (.task, .note) sets position: relative
  // later in the cascade, which would put the copy in the page's flow and stretch the layout.
  Object.assign(ghost.style, { position: 'fixed', margin: '0', boxSizing: 'border-box', zIndex: '100',
    width: `${r.width}px`, height: `${r.height}px`, left: `${r.left}px`, top: `${r.top}px` });
  document.body.append(ghost);
  active = { el, opts, ghost, dx: x0 - r.left, dy: y0 - r.top, x, y, frame: 0 };
  document.documentElement.classList.add('card-dragging');
  navigator.vibrate?.(15);
  opts.start?.();
  addEventListener('pointermove', onDragMove);
  addEventListener('pointerup', onDragUp);
  addEventListener('pointercancel', onDragCancel);
  addEventListener('keydown', onKey, true);
  place();
  active.frame = requestAnimationFrame(tick);
}

const under = () => document.elementFromPoint(active.x, active.y);

function place() {
  const { ghost, x, y, dx, dy } = active;
  ghost.style.transform = `translate(${x - dx - parseFloat(ghost.style.left)}px, ${y - dy - parseFloat(ghost.style.top)}px)`;
  active.opts.move?.(x, y, under());
}

function onDragMove(e) {
  if (!e.isPrimary) return;
  active.x = e.clientX;
  active.y = e.clientY;
  place();
}

// Each frame: scroll the list under the pointer when it's near the list's top or bottom
// edge, then let the view look again, since the content moved under a still pointer.
function tick() {
  if (!active) return;
  const box = scroller(under());
  if (box) {
    const r = box.getBoundingClientRect();
    const near = active.y < r.top + EDGE ? active.y - (r.top + EDGE) : active.y > r.bottom - EDGE ? active.y - (r.bottom - EDGE) : 0;
    if (near) {
      const before = box.scrollTop;
      box.scrollTop += Math.max(-EDGE, Math.min(EDGE, near)) / 4;
      if (box.scrollTop !== before) active.opts.move?.(active.x, active.y, under());
    }
  }
  active.frame = requestAnimationFrame(tick);
}

function scroller(el) {
  for (; el && el !== document.body; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

function onDragUp(e) {
  if (!e.isPrimary) return;
  active.x = e.clientX;
  active.y = e.clientY;
  finish(true);
}
const onDragCancel = () => finish(false);
function onKey(e) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  finish(false);
}

function finish(dropped) {
  const { opts, ghost, frame, x, y } = active;
  const target = dropped ? under() : null;
  cancelAnimationFrame(frame);
  removeEventListener('pointermove', onDragMove);
  removeEventListener('pointerup', onDragUp);
  removeEventListener('pointercancel', onDragCancel);
  removeEventListener('keydown', onKey, true);
  ghost.remove();
  document.documentElement.classList.remove('card-dragging');
  active = null;
  endedAt = performance.now();
  // The click a mouse release would fire on the card isn't a click on it.
  const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
  addEventListener('click', swallow, true);
  setTimeout(() => removeEventListener('click', swallow, true), 0);
  if (dropped) opts.drop?.(x, y, target);
  opts.end?.(dropped);
}
