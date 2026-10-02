// The signed-in profile: fetched at start and again whenever it changes (a new picture, a
// role or access change, possibly from another tab). Its name and picture show in the sidebar
// and header, and the views and badges follow its access.
import { $, h } from '../lib/dom.js';
import { pictureUrl } from '../lib/widgets.js';
import { state } from '../state.js';
import { views, renderViewTabs, refreshBadges } from './views.js';

export async function refreshMe() {
  const res = await fetch('/api/me');
  if (res.status === 401) { location.href = '/login'; return; }
  const me = await res.json();
  state.me = me;
  $('profileName').textContent = me.profile;
  $('brandProfile').textContent = me.profile;
  // The profile's picture stands in for the person icon when it has one.
  const icon = document.querySelector('.who-icon');
  icon.querySelector('img')?.remove();
  icon.querySelector('svg').toggleAttribute('hidden', !!me.picture);
  if (me.picture) icon.prepend(h('img', { class: 'picture', src: pictureUrl(me.profile, me.picture), alt: '' }));
  // Profiles with the User role don't see file and shell tool cards in chats (chat/transcript.js).
  document.body.classList.toggle('simple-chat', me.role !== 'admin');
  $('version').textContent = me.version ? `v${me.version}` : '';
  renderViewTabs();
  refreshBadges();
  for (const v of views.values()) v.profileChanged?.();
}
