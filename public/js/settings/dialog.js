// The Settings dialog: its tabs, and which of them this profile sees. Your profile and
// Permissions are everyone's; Profiles, Claude and Updates are admin-only, hidden for users
// (the server refuses them regardless). Each tab lives in its own module here.
import { $ } from '../lib/dom.js';
import { isAdmin } from './forms.js';
import { fillProfile } from './profile.js';
import { fillVoice } from './voice.js';
import { loadPermissions } from './permissions.js';
import { loadProfiles } from './profiles.js';
import { loadClaude } from './claude.js';
import { loadUpdates } from './updates.js';

const dlg = $('settings');
const LOADERS = { permissions: loadPermissions, profiles: loadProfiles, claude: loadClaude, updates: loadUpdates };

export function showTab(name) {
  if (!isAdmin() && !['profile', 'permissions'].includes(name)) name = 'profile';
  for (const t of dlg.querySelectorAll('[role=tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const p of dlg.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
  LOADERS[name]?.();
}

export function applyRole() {
  for (const el of dlg.querySelectorAll('[data-admin]')) el.hidden = !isAdmin();
}

export function openSettings(tab = 'profile') {
  applyRole();
  fillProfile();
  fillVoice();
  showTab(tab);
  if (!dlg.open) dlg.showModal();
}

for (const t of dlg.querySelectorAll('[role=tab]')) t.addEventListener('click', () => showTab(t.dataset.tab));
for (const b of document.querySelectorAll('dialog [data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
