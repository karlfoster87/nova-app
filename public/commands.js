// Slash command suggestions in the composer. Typing / as the very first character of a message
// opens the commands a chat can run: this brain's own skills and commands first, then Claude
// Code's. Typing more of the name narrows the list; a space, or anything that isn't part of a
// name, closes it. A click or tap, or Up/Down then Enter or Tab, fills the command into the box,
// ready for its arguments; it's sent like any other message. The server builds the list
// (server/commands.js), from the open chat when there is one.
import { h } from '/render.js';

const FRESH = 60 * 1000; // refetch after this, or when the open chat changes
const GROUPS = { brain: 'Skills in this brain', claude: 'Claude Code' };

// ctx: { input, menu, currentChat() -> chatId or null, onFill() after the box's text changes }
export function initCommands({ input, menu, currentChat, onFill }) {
  let list = null, error = null, loadedFor = null, loadedAt = 0, loading = null;
  let items = [], active = 0, dismissed = null;

  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', menu.id);
  input.setAttribute('aria-expanded', 'false');

  function load() {
    const chatId = currentChat() || '';
    if (list && loadedFor === chatId && Date.now() - loadedAt < FRESH) return;
    if (loading) return;
    loading = (async () => {
      try {
        const res = await fetch(`/api/commands${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`);
        if (res.status === 401) { location.href = '/login'; return; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Couldn't load the commands (${res.status}).`);
        list = data;
        error = null;
        loadedFor = chatId;
        loadedAt = Date.now();
      } catch (err) {
        error = err.message; // a stale list still shows; the next / tries again
        loadedAt = 0;
      } finally {
        loading = null;
      }
      if (isOpen()) render();
    })();
  }

  // The name typed after the /, or null when the list shouldn't show.
  const typed = () => /^\/([^\s/]*)$/.exec(input.value)?.[1] ?? null;
  const isOpen = () => !menu.hidden;

  // Names that start with what's typed come first, then aliases that do, then names containing it.
  function matches(q) {
    const t = q.toLowerCase();
    const score = (c) => {
      const name = c.name.toLowerCase();
      if (name.startsWith(t)) return 0;
      if (c.aliases.some((a) => a.toLowerCase().startsWith(t))) return 1;
      if (name.includes(t)) return 2;
      return -1;
    };
    return (list || []).map((c) => ({ c, s: score(c) })).filter((x) => x.s >= 0)
      .sort((a, b) => (a.c.source === b.c.source ? a.s - b.s || a.c.name.localeCompare(b.c.name) : a.c.source === 'brain' ? -1 : 1))
      .map((x) => x.c);
  }

  function note(text) { return h('li', { class: 'cmd-note', role: 'presentation' }, text); }

  function render() {
    const q = typed();
    if (q === null) return close();
    items = list ? matches(q) : [];
    active = Math.min(active, Math.max(items.length - 1, 0));
    const rows = [];
    if (!list) rows.push(note(error || 'Loading commands…'));
    else if (!items.length) rows.push(note(`No command matches /${q}`));
    let group = null;
    items.forEach((c, i) => {
      if (c.source !== group) {
        group = c.source;
        rows.push(h('li', { class: 'cmd-group', role: 'presentation' }, GROUPS[group] || group));
      }
      rows.push(h('li', {
        id: `cmd-option-${i}`, class: 'cmd-item', role: 'option', 'aria-selected': String(i === active),
        onmousedown: (e) => e.preventDefault(), // keeps the focus (and a phone's keyboard) in the box
        onclick: () => pick(i)
      },
      h('span', { class: 'cmd-line' }, h('span', { class: 'cmd-name' }, `/${c.name}`),
        c.argumentHint ? h('span', { class: 'cmd-args' }, c.argumentHint) : null),
      c.description ? h('span', { class: 'cmd-desc' }, c.description) : null));
    });
    if (list && error) rows.push(note('This list may be out of date: the latest refresh failed.'));
    menu.replaceChildren(...rows);
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    paintActive();
  }

  function paintActive() {
    for (const li of menu.querySelectorAll('.cmd-item')) li.setAttribute('aria-selected', String(li.id === `cmd-option-${active}`));
    const el = menu.querySelector(`#cmd-option-${active}`);
    if (el) { input.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }

  function close() {
    if (!isOpen()) return;
    menu.hidden = true;
    menu.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function pick(i) {
    const c = items[i];
    if (!c) return;
    input.value = `/${c.name} `;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    close();
    onFill();
  }

  function update() {
    if (typed() === null || input.value === dismissed) { close(); return; }
    dismissed = null;
    if (!isOpen()) active = 0;
    load();
    render();
  }

  // Keys the list uses while it's open. Returns true when it handled the key, so the composer
  // doesn't also act on it (Enter would send).
  function onKeydown(e) {
    if (!isOpen() || e.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (items.length) active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      paintActive();
      e.preventDefault();
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      if (!items.length) { close(); return false; } // nothing to pick: Enter sends what was typed
      e.preventDefault();
      pick(active);
      return true;
    }
    if (e.key === 'Escape') {
      dismissed = input.value; // stays closed until the text changes
      close();
      e.preventDefault();
      return true;
    }
    return false;
  }

  input.addEventListener('input', update);
  input.addEventListener('focus', load); // warm the list before it's needed
  input.addEventListener('blur', close);
  input.addEventListener('click', () => { if (!isOpen() && typed() !== null && input.value !== dismissed) update(); });

  return { onKeydown, close };
}
