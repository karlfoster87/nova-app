// Keeps the transcript at its end while the reader is there. A chat opens at its last
// message and stays there as anything below grows: replies streaming in, code and images
// laying out late, the phone keyboard shrinking the view. Scrolling up stops the following,
// and a button over the composer jumps back down. Jumps are instant, since the transcript's
// smooth scrolling would otherwise animate them and stop short of content added meanwhile.
import { h, svgIcon } from '../lib/dom.js';
import { els } from '../state.js';

const box = els.transcript;
const NEAR = 80; // within this many pixels of the end counts as at the end
let follow = true;
let chasing = false; // the button's smooth scroll is on its way down

const atEnd = () => box.scrollHeight - box.scrollTop - box.clientHeight < NEAR;
const jump = () => box.scrollTo({ top: box.scrollHeight, behavior: 'instant' });

const button = h('button', { type: 'button', class: 'to-bottom', title: 'Go to the latest message', 'aria-label': 'Go to the latest message', hidden: true },
  svgIcon('M12 5v14M6 13l6 6 6-6'));
button.addEventListener('click', () => {
  follow = chasing = true;
  sync();
  box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
});
els.composer.prepend(button);

function sync() { button.hidden = follow; }

box.addEventListener('scroll', () => {
  if (chasing && !atEnd()) return;
  chasing = false;
  follow = atEnd();
  sync();
}, { passive: true });
// The reader taking over cancels the button's scroll.
for (const type of ['wheel', 'touchstart', 'keydown']) box.addEventListener(type, () => { chasing = false; }, { passive: true });

const resized = new ResizeObserver(() => { if (follow && !chasing) jump(); else sync(); });

// A transcript was put in the view. keep is where the reader was in an earlier copy of the
// same chat (spot()), so a reload leaves them there; otherwise it opens at the end.
export function mounted(inner, keep = null) {
  resized.disconnect();
  resized.observe(box);
  resized.observe(inner);
  chasing = false;
  if (keep && !keep.follow) {
    follow = false;
    box.scrollTo({ top: keep.top, behavior: 'instant' });
    follow = atEnd();
  } else {
    follow = true;
    jump();
  }
  sync();
}

export const spot = () => ({ follow, top: box.scrollTop });

// Something was added: stay at the end if the reader is there.
export function stick() { if (follow && !chasing) jump(); }
