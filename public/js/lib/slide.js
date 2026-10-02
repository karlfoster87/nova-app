// Sliding text for names too long for their space (chat titles): the clipped text slides
// sideways to show its end, pauses, and slides back. The element needs the `slide` class and
// its text in one inner <span>; CSS (base.css) does the motion. Text that fits never moves,
// and with reduced motion it never slides at all (the ellipsis and the title tooltip remain).

// Starts the slide if the text overflows. once: there and back a single time; otherwise it
// repeats until stopSlide.
export function slide(el, once = false) {
  if (!el) return;
  el.classList.remove('sliding', 'once');
  const over = el.scrollWidth - el.clientWidth;
  if (over < 2) return;
  el.style.setProperty('--slide-by', `${-over}px`);
  el.style.setProperty('--slide-time', `${(2.4 + over / 40).toFixed(1)}s`);
  void el.offsetWidth; // restart the animation if it was already running
  el.classList.add('sliding');
  el.classList.toggle('once', once);
  if (once) el.addEventListener('animationend', () => stopSlide(el), { once: true });
}

export const stopSlide = (el) => el?.classList.remove('sliding', 'once');

// Rows in a list slide their `.slide` text while hovered or focused.
export function slideOnHover(list, rowSelector) {
  const slideIn = (row) => row?.querySelector('.slide');
  // Moving between a row's parts mustn't restart a slide already going.
  const start = (el) => { if (el && !(el.classList.contains('sliding') && !el.classList.contains('once'))) slide(el); };
  list.addEventListener('pointerover', (e) => { if (e.pointerType === 'mouse') start(slideIn(e.target.closest(rowSelector))); });
  list.addEventListener('pointerout', (e) => {
    const row = e.target.closest(rowSelector);
    if (row && !row.contains(e.relatedTarget) && !row.contains(document.activeElement)) stopSlide(slideIn(row));
  });
  list.addEventListener('focusin', (e) => start(slideIn(e.target.closest(rowSelector))));
  list.addEventListener('focusout', (e) => {
    const row = e.target.closest(rowSelector);
    if (row && !row.contains(e.relatedTarget)) stopSlide(slideIn(row));
  });
}
