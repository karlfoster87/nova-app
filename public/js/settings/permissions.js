// Settings → Permissions: this profile's extra folders and remembered approvals ("Always
// allow" rules). An admin can also share a rule with every profile.
import { $, h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { confirmDialog } from '../lib/dialog.js';
import { run, setStatus, isAdmin } from './forms.js';

const folderForm = $('folderForm'), folderRows = $('folderRows');
const approvalRows = $('approvalRows'), approvalStatus = $('approvalBox').querySelector('.form-status');
const folderStatus = folderForm.querySelector('.form-status');

export function loadPermissions() {
  setStatus(folderStatus, '');
  setStatus(approvalStatus, '');
  api('GET', '/api/folders').then(renderFolders, (err) => setStatus(folderStatus, err.message, true));
  api('GET', '/api/approvals').then(renderApprovals, (err) => setStatus(approvalStatus, err.message, true));
}

// ---- Extra folders --------------------------------------------------------------

function renderFolders(list) {
  folderRows.replaceChildren(...(list.length ? list.map((f) => {
    const remove = h('button', { type: 'button', class: 'text-btn' }, 'Remove');
    remove.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Remove this folder?', message: `Claude will no longer be able to use ${f.path} in your chats.`,
        confirm: 'Remove folder', danger: true }))) return;
      try { renderFolders(await api('DELETE', '/api/folders', { path: f.path })); setStatus(folderStatus, `Removed ${f.path}.`); }
      catch (err) { setStatus(folderStatus, err.message, true); }
    });
    return h('div', { class: 'profile-row' }, h('div', { class: 'profile-main' }, h('code', {}, f.path)), remove);
  }) : [h('p', { class: 'muted' }, 'No extra folders. Chats can use the brain folder and your notes folder.')]));
}

folderForm.addEventListener('submit', (e) => {
  e.preventDefault();
  run(folderForm, async () => {
    const path = folderForm.path.value.trim();
    if (!(await confirmDialog({ title: 'Let Claude use this folder in all your chats?', confirm: 'Add folder',
      message: `${path}\n\nClaude can read files there, and change them when you allow it.` }))) return '';
    const r = await api('POST', '/api/folders', { path });
    folderForm.reset();
    renderFolders(r.folders);
    return `Added ${r.path}.`;
  });
});

// ---- Remembered approvals -----------------------------------------------------

// Rules are often long commands, so shorten them in dialogs and status lines.
const short = (s, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function renderApprovals(list) {
  approvalRows.replaceChildren(...(list.length ? list.map(ruleCard)
    : [h('p', { class: 'muted' }, 'Nothing yet. Use Always allow on a permission prompt to add a rule.')]));
}

// One rule: tool name, then the rule itself clamped to a few lines, then its actions.
function ruleCard(a) {
  const text = h('pre', { class: 'rule-text' }, a.rule || 'Any use of this tool');
  const more = h('button', { type: 'button', class: 'text-btn', hidden: true, 'aria-expanded': 'false' }, 'Show all');
  more.addEventListener('click', () => {
    const open = text.classList.toggle('open');
    more.textContent = open ? 'Show less' : 'Show all';
    more.setAttribute('aria-expanded', String(open));
  });
  requestAnimationFrame(() => { more.hidden = text.scrollHeight <= text.clientHeight + 1; }); // only when clamped

  const remove = h('button', { type: 'button', class: 'text-btn' }, 'Remove');
  remove.addEventListener('click', async () => {
    try { renderApprovals(await api('DELETE', '/api/approvals', { tool: a.tool, rule: a.rule })); setStatus(approvalStatus, `Removed ${short(a.text)}.`); }
    catch (err) { setStatus(approvalStatus, err.message, true); }
  });
  const share = isAdmin() ? h('button', { type: 'button', class: 'text-btn' }, 'Share with all profiles') : null;
  share?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Allow this rule for every profile?', confirm: 'Share rule',
      message: `${short(a.text, 300)}\n\nNova adds it to the brain's .claude/settings.local.json and removes it from this list. To undo, remove it from that file.` }))) return;
    try {
      const r = await api('POST', '/api/approvals/share', { tool: a.tool, rule: a.rule });
      renderApprovals(r.approvals);
      setStatus(approvalStatus, `${short(r.text)} is now allowed for every profile, in ${r.file}.`);
    } catch (err) { setStatus(approvalStatus, err.message, true); }
  });
  const added = new Date(a.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
  return h('div', { class: 'rule' },
    h('div', { class: 'rule-head' }, h('strong', {}, a.tool), h('span', { class: 'muted' }, `Added ${added}`)),
    text,
    h('div', { class: 'row' }, more, h('span', { class: 'spacer' }), share, remove));
}
