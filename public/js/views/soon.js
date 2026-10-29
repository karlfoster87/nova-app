// Placeholder for the Core tab's views still being built (Heartbeat, Thought), so the group's
// switch shows the whole plan. ctx.id says which one this is.
import { h, svgIcon } from '../lib/dom.js';

const ABOUT = {
  heartbeat: ['Heartbeat', 'Scheduled and triggered work that Nova does without being asked: on a timetable, or when something like Home Assistant calls in.'],
  thought: ['Thought', 'A timeline of what Nova has done, when and why: finished tasks, commits and its own scheduled work, in a line or two each.']
};

export function init(ctx) {
  const [title, about] = ABOUT[ctx.id] || [ctx.id, ''];
  ctx.side.append(h('div', { class: 'brain-side-head' }, h('span', { class: 'cat-label' }, title)),
    h('div', { class: 'soul-about' }, h('p', {}, about)));
  ctx.main.append(h('header', { class: 'topbar brain-bar' },
    h('button', { type: 'button', class: 'icon-btn menu-btn', 'aria-label': 'Show the sidebar' }, svgIcon('M4 6h16M4 12h16M4 18h16')),
    h('p', { class: 'brain-crumbs' }, h('span', { class: 'crumb-file' }, title))),
  h('section', { class: 'brain-doc' }, h('div', { class: 'empty' }, h('h2', {}, `${title} is coming soon`), h('p', {}, about))));
  return { show() { ctx.setRoute(''); } };
}
