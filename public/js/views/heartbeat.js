// Heartbeat view: the profile's schedules, the work Nova does by itself on a timetable. This is
// where they are audited and removed without asking Nova: each schedule shows what it runs, when,
// where (behind the scenes or in a chat), who made it, how its last runs went, and the transcript
// of any behind-the-scenes run. Edit access to the Core tab can add, change, pause, run, stop and
// delete them; read access can only look. The server checks both (heartbeat/schedules.js).
// Routes: #heartbeat, #heartbeat/<schedule id>, #heartbeat/new, #heartbeat/run/<run chat id>.
import { h, svgIcon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { confirmDialog } from '../lib/dialog.js';
import { openMenu } from '../lib/menu.js';
import { state } from '../state.js';
import { Transcript } from '../chat/transcript.js';
import { goToChat } from '../shell/views.js';

const PULSE = ['M3 12h4l2-6 4 12 2-6h6'];
const PLUS = ['M12 5v14M5 12h14'];
const MORE = ['M5 12h.01M12 12h.01M19 12h.01'];
const BACK = ['M15 18l-6-6 6-6'];
const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const when = (ms) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
// "in 12 min", "in 3 h", "5 min ago".
function relative(ms) {
  const d = ms - Date.now(), a = Math.abs(d), m = Math.round(a / 60000);
  const text = m < 1 ? 'under a minute' : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
  return d >= 0 ? `in ${text}` : `${text} ago`;
}

export function init(ctx) {
  const { side, main } = ctx;
  let schedules = null;   // as /api/heartbeats sent them
  let selected = null;    // a schedule id
  let mode = 'view';      // 'view' | 'edit' | 'new' | 'run'
  let run = null;         // the open run: { id, data }
  let runs = [];          // the selected schedule's recent Thought entries
  let form = null;        // the open form's fields
  let chats = [];         // the profile's chats, for "Runs in"
  let poll = null;
  const canEdit = () => ctx.access() === 'edit';

  // ---- Layout -------------------------------------------------------------
  const newBtn = h('button', { type: 'button', class: 'icon-btn', title: 'New schedule', 'aria-label': 'New schedule', onclick: () => openNew() }, svgIcon(PLUS));
  const listEl = h('div', { class: 'chat-list hb-list', role: 'list' });
  side.append(h('div', { class: 'brain-side-head' }, h('span', { class: 'cat-label' }, 'Heartbeat'), newBtn), listEl,
    h('div', { class: 'soul-about hb-about' },
      h('p', {}, 'Work Nova does by itself, on a timetable. Ask Nova to schedule something, or add it here.'),
      h('p', { class: 'muted' }, 'Runs behind the scenes are non-destructive: anything that would delete, overwrite or change things is held back for you in Thought.')));

  const crumbs = h('p', { class: 'brain-crumbs' });
  const actions = h('div', { class: 'brain-actions' });
  const doc = h('section', { class: 'brain-doc hb-doc' });
  const status = h('div', { class: 'brain-status', role: 'status' });
  main.append(h('header', { class: 'topbar brain-bar' },
    h('button', { type: 'button', class: 'icon-btn menu-btn', 'aria-label': 'Show the sidebar' }, svgIcon('M4 6h16M4 12h16M4 18h16')),
    crumbs, actions), doc, status);

  function setStatus(text = '', isError = false) {
    status.replaceChildren(...(text ? [h('span', {}, text)] : []));
    status.classList.toggle('error', isError);
  }
  const current = () => schedules?.find((s) => s.id === selected) || null;

  // ---- Loading ------------------------------------------------------------
  async function load() {
    try {
      schedules = await api('GET', '/api/heartbeats');
      if (selected && !current() && mode !== 'run') { selected = null; if (mode === 'edit') mode = 'view'; }
      renderList();
      if (mode === 'view') { await loadRuns(); render(); }
    } catch (err) { setStatus(err.message, true); }
  }

  async function loadRuns() {
    runs = [];
    if (!selected) return;
    try { runs = (await api('GET', `/api/thoughts?schedule=${encodeURIComponent(selected)}`)).thoughts; } catch {}
  }

  async function loadChats() {
    try { chats = (await api('GET', '/api/chats')).filter((c) => c.title); } catch { chats = []; }
  }

  // ---- Sidebar ------------------------------------------------------------
  function stateLine(s) {
    if (s.running) return h('time', { class: 'hb-running' }, 'Running');
    if (!s.enabled) return h('time', {}, 'Paused');
    return s.nextRun ? h('time', { title: when(s.nextRun) }, relative(s.nextRun)) : h('time', {}, '');
  }

  function renderList() {
    newBtn.hidden = !canEdit();
    if (!schedules) return;
    if (!schedules.length) {
      listEl.replaceChildren(h('p', { class: 'cat-empty' }, canEdit() ? 'No schedules yet.' : 'This profile has no schedules.'));
      return;
    }
    listEl.replaceChildren(...schedules.map((s) => h('button', {
      type: 'button', role: 'listitem', class: `chat-item hb-item${s.enabled ? '' : ' paused'}`, 'aria-current': String(s.id === selected && mode !== 'new'),
      title: `${s.name}: ${s.cadence}`, onclick: () => select(s.id)
    }, svgIcon(PULSE), h('span', {}, s.name), stateLine(s), h('i', { class: `dot${s.running ? ' running' : ''}`, 'aria-hidden': 'true' }))));
  }

  // ---- Main pane ----------------------------------------------------------
  function setCrumbs(...parts) {
    crumbs.replaceChildren(h('span', {}, 'Heartbeat'), ...parts.flatMap((p) => [h('span', { class: 'crumb-sep' }, '›'), h('span', { class: 'crumb-file' }, p)]));
    if (!parts.length) crumbs.lastChild.className = 'crumb-file';
  }

  function render() {
    actions.replaceChildren();
    if (mode === 'new' || mode === 'edit') return renderForm();
    if (mode === 'run') return renderRun();
    const s = current();
    if (!s) return renderEmpty();
    setCrumbs(s.name);
    ctx.setRoute(s.id);
    if (canEdit()) {
      actions.append(
        s.running ? h('button', { type: 'button', class: 'stop-btn', onclick: () => act('stop') }, 'Stop')
          : h('button', { type: 'button', class: 'text-btn', onclick: () => act('run') }, 'Run now'),
        h('button', { type: 'button', class: 'text-btn', onclick: () => act(s.enabled ? 'pause' : 'resume') }, s.enabled ? 'Pause' : 'Resume'),
        h('button', { type: 'button', class: 'text-btn', onclick: () => openEdit() }, 'Edit'),
        h('button', { type: 'button', class: 'icon-btn', title: 'More', 'aria-label': 'More actions', 'aria-haspopup': 'menu',
          onclick: (e) => openMenu(e.currentTarget, [{ label: 'Delete schedule', danger: true, action: () => remove(s) }]) }, svgIcon(MORE)));
    }
    const fact = (label, ...value) => [h('dt', {}, label), h('dd', {}, ...value)];
    const chatLink = (c) => h('button', { type: 'button', class: 'link-btn', onclick: () => goToChat(c.id) }, `“${c.title}”`);
    const last = s.lastRun ? [`${when(s.lastRun)}: ${s.lastStatus || ''} `,
      s.lastChat && !s.targetChat ? h('button', { type: 'button', class: 'link-btn', onclick: () => openRun(s.lastChat) }, 'Open run') : null] : ['Not yet'];
    doc.replaceChildren(h('article', { class: 'brain-article hb-detail' },
      h('header', { class: 'hb-head' }, h('h2', {}, s.name),
        h('span', { class: `hb-chip ${s.running ? 'on' : s.enabled ? '' : 'off'}` }, s.running ? 'Running' : s.enabled ? 'Active' : 'Paused'),
        s.createdBy === 'nova' ? h('span', { class: 'hb-chip nova' }, 'Set up by Nova') : null),
      canEdit() ? null : h('p', { class: 'brain-readonly' }, 'View only: this profile can see its schedules but not change them.'),
      h('dl', { class: 'hb-facts' },
        ...fact('When', s.cadence, s.at ? h('span', { class: 'muted' }, ' (server time)') : null),
        ...fact('Next run', s.running ? 'Running now' : s.nextRun ? `${when(s.nextRun)} (${relative(s.nextRun)})` : 'Paused'),
        ...fact('Runs', s.targetChat ? ['In the chat ', chatLink(s.targetChat)] : 'Behind the scenes, in a fresh session each time'),
        ...fact('Model', [modelName(s.model), s.effort ? `, ${s.effort} effort` : ''].join('')),
        ...fact('Last run', ...last),
        ...fact('Runs so far', String(s.runs)),
        ...fact('Made', `${s.createdBy === 'nova' ? 'by Nova' : 'by you'} on ${when(s.createdAt)}`, s.createdChat ? [' in ', chatLink(s.createdChat)] : null)),
      h('h3', { class: 'hb-sub' }, 'Each run, Nova is asked'),
      h('div', { class: 'hb-prompt' }, s.prompt),
      h('h3', { class: 'hb-sub' }, 'Recent runs'),
      runs.length ? h('ol', { class: 'hb-runs' }, ...runs.map(runRow)) : h('p', { class: 'muted' }, 'Nothing recorded yet.')));
  }

  function runRow(t) {
    return h('li', { class: `hb-run${t.kind === 'held' ? ' held' : ''}` },
      h('time', { title: when(t.at) }, when(t.at)),
      h('div', {}, h('p', {}, t.summary), t.question ? h('p', { class: 'hb-question' }, `Question: ${t.question}`) : null),
      t.chatId ? h('button', { type: 'button', class: 'link-btn', onclick: () => openRun(t.chatId) }, 'Open run') : h('span'));
  }

  function renderEmpty() {
    setCrumbs();
    ctx.setRoute('');
    doc.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Heartbeat'),
      h('p', {}, schedules?.length ? 'Choose a schedule to see what it does and how its runs went.'
        : 'Nothing is scheduled. Ask Nova, for example “every hour, check what happened in Home Assistant and tell me if anything is worth thinking about”.'),
      canEdit() ? h('p', {}, h('button', { type: 'button', class: 'send-btn', onclick: () => openNew() }, 'New schedule')) : null));
  }

  const modelName = (value) => (value ? state.meta?.allModels?.find((m) => m.value === value)?.displayName || value : 'Default model');

  // ---- Actions ------------------------------------------------------------
  async function act(what) {
    const s = current();
    if (!s) return;
    try {
      if (what === 'run') { await api('POST', `/api/heartbeats/${s.id}/run`); setStatus('Started. It records what it finds in Thought when it\'s done.'); }
      else if (what === 'stop') { await api('POST', `/api/heartbeats/${s.id}/stop`); setStatus('Stopping…'); }
      else { await api('PATCH', `/api/heartbeats/${s.id}`, { enabled: what === 'resume' }); setStatus(what === 'resume' ? 'Resumed.' : 'Paused. It won\'t run until you resume it.'); }
      await load();
    } catch (err) { setStatus(err.message, true); }
  }

  async function remove(s) {
    if (!(await confirmDialog({ title: `Delete “${s.name}”?`, message: 'It stops running. What its past runs recorded stays in Thought.',
      confirm: 'Delete schedule', danger: true }))) return;
    try {
      await api('DELETE', `/api/heartbeats/${s.id}`);
      selected = null;
      setStatus('Deleted.');
      await load();
      render();
    } catch (err) { setStatus(err.message, true); }
  }

  async function select(id) {
    if (!(await leaveForm())) return;
    selected = id; mode = 'view'; run = null;
    setStatus('');
    renderList();
    loadRuns().then(render);
    ctx.closeSidebar();
  }

  // ---- A run's transcript ---------------------------------------------------
  async function openRun(id) {
    if (!(await leaveForm())) return;
    mode = 'run';
    run = { id, data: null };
    render();
    await refreshRun();
    ctx.closeSidebar();
  }

  async function refreshRun() {
    clearTimeout(poll);
    if (!run) return;
    try {
      run.data = await api('GET', `/api/heartbeat-runs/${run.id}`);
      if (run.data.scheduleId && schedules?.some((s) => s.id === run.data.scheduleId)) { selected = run.data.scheduleId; renderList(); }
      if (mode === 'run') renderRun();
      // A run in progress has no tab to stream to, so the pane looks again every few seconds.
      if (run.data.running) poll = setTimeout(refreshRun, 4000);
    } catch (err) {
      setStatus(err.message, true);
      if (mode === 'run') doc.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Run not found'), h('p', {}, err.message)));
    }
  }

  function renderRun() {
    const d = run?.data;
    setCrumbs(...(d ? [d.title] : ['Run']));
    ctx.setRoute(`run/${run.id}`);
    actions.replaceChildren(h('button', { type: 'button', class: 'text-btn', onclick: () => { mode = 'view'; run = null; clearTimeout(poll); render(); } },
      svgIcon(BACK, { class: 'btn-icon' }), 'Back'));
    if (!d) { doc.replaceChildren(h('p', { class: 'muted' }, 'Loading the run…')); return; }
    const t = new Transcript(d.id, { loading: true });
    t.loadHistory(d.messages);
    t.setBusy(d.running);
    doc.replaceChildren(h('div', { class: 'hb-run-view' },
      h('p', { class: 'brain-readonly' }, d.running ? 'This run is still going. The transcript updates by itself.'
        : 'A behind-the-scenes run: nobody was asked anything, and anything destructive was held back.'),
      d.messages.length ? t.el : h('p', { class: 'muted' }, 'Nothing was saved for this run.')));
  }

  // ---- New and edit ---------------------------------------------------------
  async function openNew() {
    if (!canEdit() || !(await leaveForm())) return;
    await loadChats();
    mode = 'new'; run = null;
    form = fields(null);
    render();
    ctx.setRoute('new');
    form.name.focus();
  }

  async function openEdit() {
    if (!(await leaveForm())) return;
    await loadChats();
    mode = 'edit';
    form = fields(current());
    render();
    form.name.focus();
  }

  // A half-filled form survives switching to another view and back, as in the Soul; leaving it for
  // another schedule in this pane asks first.
  let formDirty = false;
  async function leaveForm() {
    if ((mode !== 'new' && mode !== 'edit') || !formDirty) { formDirty = false; return true; }
    const ok = await confirmDialog({ title: 'Discard this schedule?', message: 'Your changes haven\'t been saved.',
      confirm: 'Discard changes', cancel: 'Keep editing', danger: true });
    if (ok) formDirty = false;
    return ok;
  }

  function fields(s) {
    const input = (attrs, value) => { const el = h('input', attrs); if (value != null) el.value = value; el.addEventListener('input', () => { formDirty = true; }); return el; };
    const f = {
      name: input({ type: 'text', maxlength: 80, required: true, placeholder: 'Home Assistant check-in' }, s?.name),
      prompt: h('textarea', { rows: 7, maxlength: 4000, required: true,
        placeholder: 'Look at what happened in Home Assistant in the last hour. If you notice a pattern or anything worth thinking about, such as something we might automate, raise it as a question.' }),
      kind: s?.at ? 'at' : 'every',
      every: input({ type: 'number', min: 1, step: 1 }, s?.everyMinutes ? (s.everyMinutes % 60 === 0 ? s.everyMinutes / 60 : s.everyMinutes) : 1),
      unit: h('select', {}, new Option('hours', '60'), new Option('minutes', '1')),
      at: input({ type: 'time' }, s?.at || '08:00'),
      days: new Set(s?.days?.length ? s.days : DAYS.map(([d]) => d)),
      target: h('select', {}, new Option('Behind the scenes (a fresh run each time)', ''), ...chats.map((c) => new Option(`In the chat “${c.title}”`, c.id))),
      model: h('select', {}, new Option('Default model', ''), ...(state.meta?.models || []).map((m) => new Option(m.displayName || m.value, m.value))),
      effort: h('select', {}, new Option('Default effort', ''), ...EFFORTS.map((e) => new Option(`${e} effort`, e)))
    };
    f.prompt.value = s?.prompt || '';
    f.prompt.addEventListener('input', () => { formDirty = true; });
    if (s?.everyMinutes && s.everyMinutes % 60 !== 0) f.unit.value = '1';
    if (s?.targetChat) {
      if (![...f.target.options].some((o) => o.value === s.targetChat.id)) f.target.append(new Option(`In the chat “${s.targetChat.title}”`, s.targetChat.id));
      f.target.value = s.targetChat.id;
    }
    if (s?.model) { if (![...f.model.options].some((o) => o.value === s.model)) f.model.append(new Option(s.model, s.model)); f.model.value = s.model; }
    if (s?.effort) f.effort.value = s.effort;
    return f;
  }

  function renderForm() {
    const s = mode === 'edit' ? current() : null;
    setCrumbs(s ? `Edit ${s.name}` : 'New schedule');
    const f = form;
    const radio = (value, label) => h('label', { class: 'hb-radio' },
      h('input', { type: 'radio', name: 'hb-kind', value, checked: f.kind === value, onchange: () => { f.kind = value; formDirty = true; renderForm(); } }), label);
    const dayBox = ([d, label]) => h('label', { class: 'hb-day' }, h('input', { type: 'checkbox', checked: f.days.has(d),
      onchange: (e) => { if (e.target.checked) f.days.add(d); else f.days.delete(d); formDirty = true; } }), label);
    const formEl = h('form', { class: 'hb-form', onsubmit: (e) => { e.preventDefault(); save(); } },
      h('label', {}, 'Name', f.name),
      h('label', {}, 'What Nova does each run', f.prompt),
      h('p', { class: 'muted hb-hint' }, 'Each run starts fresh, so say everything Nova needs. It can look at what earlier runs noted in Thought.'),
      h('fieldset', {}, h('legend', {}, 'When'),
        h('div', { class: 'hb-when' }, radio('every', 'Repeat every'), f.every, f.unit),
        h('div', { class: 'hb-when' }, radio('at', 'At'), f.at, h('span', { class: 'muted' }, 'server time, on')),
        f.kind === 'at' ? h('div', { class: 'hb-days' }, ...DAYS.map(dayBox)) : null),
      h('label', {}, 'Runs', f.target),
      h('div', { class: 'hb-pair' }, h('label', {}, 'Model', f.model), h('label', {}, 'Effort', f.effort)),
      h('div', { class: 'row' }, h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'text-btn', onclick: cancelForm }, 'Cancel'),
        h('button', { type: 'submit', class: 'send-btn' }, s ? 'Save' : 'Add schedule')));
    f.every.disabled = f.unit.disabled = f.kind !== 'every';
    f.at.disabled = f.kind !== 'at';
    doc.replaceChildren(h('article', { class: 'brain-article hb-detail' }, formEl));
  }

  function cancelForm() {
    formDirty = false;
    mode = 'view';
    form = null;
    setStatus('');
    render();
  }

  async function save() {
    const f = form;
    const body = {
      name: f.name.value, prompt: f.prompt.value, targetChatId: f.target.value || null, model: f.model.value || null, effort: f.effort.value || null,
      ...(f.kind === 'every' ? { everyMinutes: Math.round(Number(f.every.value) * Number(f.unit.value)), at: null }
        : { at: f.at.value, days: DAYS.map(([d]) => d).filter((d) => f.days.has(d)), everyMinutes: null })
    };
    if (f.kind === 'at' && !body.days.length) { setStatus('Choose at least one day.', true); return; }
    try {
      setStatus('Saving…');
      const out = mode === 'edit' ? await api('PATCH', `/api/heartbeats/${selected}`, body) : await api('POST', '/api/heartbeats', body);
      formDirty = false;
      selected = out.id; mode = 'view'; form = null;
      setStatus(`Saved. ${out.enabled && out.nextRun ? `Next run ${when(out.nextRun)}.` : ''}`);
      await load();
    } catch (err) { setStatus(err.message, true); }
  }

  window.addEventListener('beforeunload', (e) => { if (formDirty) { e.preventDefault(); e.returnValue = ''; } });

  // The next-run times in the list count down.
  setInterval(() => { if (schedules && !side.hidden) renderList(); }, 30 * 1000);

  // ---- View lifecycle -------------------------------------------------------
  let started = false;
  return {
    show(arg) {
      const [first, rest] = String(arg || '').split('/');
      if (first === 'run' && rest) { load(); openRun(rest); return; }
      if (first === 'new') { load().then(openNew); return; }
      if (first && /^[0-9a-f-]{36}$/.test(first)) { selected = first; mode = 'view'; }
      if (!started || mode === 'view') { started = true; load().then(() => { if (mode === 'view') render(); }); }
      else render();
    },
    hide() { clearTimeout(poll); },
    onServer(m) {
      if (!started) return;
      if (m.t === 'heartbeat_changed') load();
      else if (m.t === 'thought_changed' && mode === 'view' && selected) loadRuns().then(render);
    },
    profileChanged() { if (started) load(); }
  };
}
