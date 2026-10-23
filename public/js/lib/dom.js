// Building the page without innerHTML: h() for elements, svgIcon() for the line icons, and $
// for the fixed elements in index.html. Text always goes in as text, never as markup.

export const $ = (id) => document.getElementById(id);

// h('button', { class: 'x', onclick: fn, disabled: true }, 'Label', child, [more]). Attributes
// that are null, undefined or false are left out; on* attributes become listeners.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

// A 24×24 line icon from one path string or several (the CSS draws the stroke). attrs go on
// the <svg>, e.g. a class.
const SVG = 'http://www.w3.org/2000/svg';
export function svgIcon(paths, attrs = {}) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [k, v] of Object.entries(attrs)) if (v != null) svg.setAttribute(k, v);
  for (const d of [].concat(paths)) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

// The copy and copied icons, for any button that copies something.
export const COPY_ICON = ['M9 9h11v11H9Z', 'M15 5V4H4v11h1'];
export const COPIED_ICON = ['M5 12.5 10 17.5 19 7'];

// Puts text on the clipboard. Over plain http (a LAN address) the async clipboard API is
// missing, so it falls back to a hidden textarea and the old copy command. Throws if both fail.
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const area = h('textarea', { readonly: true, class: 'copy-buffer' });
  area.value = text;
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy failed');
}
