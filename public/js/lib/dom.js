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
