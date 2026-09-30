// The header bar: the clock, and the plan usage meters (or a sign-in prompt when Claude isn't
// connected). Crossing 75% or 90% of a limit is logged once per tab.
import { $, h } from '../lib/dom.js';
import { state, els } from '../state.js';
import { log } from '../presence/log.js';
import { openSettings } from '../settings/dialog.js';

// ---- Clock --------------------------------------------------------------------
const clock = $('clock');
function tickClock() {
  const now = new Date();
  clock.textContent = now.toLocaleTimeString('en-GB', { hour12: false });
  clock.dateTime = now.toISOString();
}
tickClock();
setInterval(tickClock, 1000);

// ---- Usage meters -------------------------------------------------------------
const WINDOWS = [['five_hour', 'Session'], ['seven_day', 'Week'], ['seven_day_opus', 'Opus week'], ['seven_day_sonnet', 'Sonnet week']];
// window -> 0, 75 or 90, so crossing a threshold is logged once. Kept for the tab like the
// log itself, so a reload doesn't log the same warning again.
const usageLevel = (() => { try { return new Map(Object.entries(JSON.parse(sessionStorage.getItem('nova.usageLevels')) || {})); } catch { return new Map(); } })();
function logUsage(key, label, pct, status) {
  const level = pct >= 90 || status === 'rejected' ? 90 : pct >= 75 || status === 'allowed_warning' ? 75 : 0;
  if (level > (usageLevel.get(key) || 0)) log(level === 90 ? 'error' : 'system', `${label} usage at ${Math.round(pct)}%`);
  usageLevel.set(key, level);
  try { sessionStorage.setItem('nova.usageLevels', JSON.stringify(Object.fromEntries(usageLevel))); } catch {}
}
const usageNote = (text) => h('span', { class: 'usage-note' }, text);

export function renderUsage() {
  const signedIn = state.meta?.signedIn;
  // Signed out: say so where the bars go, with the way back in for admins.
  if (signedIn === false) {
    if (state.me?.role !== 'admin') { els.usage.replaceChildren(usageNote('Claude isn\'t connected. Ask an admin to sign in')); return; }
    els.usage.replaceChildren(usageNote('Claude isn\'t connected.'),
      h('button', { type: 'button', class: 'text-btn', onclick: () => openSettings('claude') }, 'Sign in'));
    return;
  }
  const u = state.meta?.usage;
  if (!u) { els.usage.replaceChildren(); return; }
  if (u.available === false) {
    els.usage.replaceChildren(...(signedIn ? [usageNote('Plan limits aren\'t reported for Anthropic Console sign-ins')] : []));
    return;
  }
  els.usage.replaceChildren(...WINDOWS.filter(([k]) => u.windows?.[k]?.utilization != null).map(([k, label]) => {
    const w = u.windows[k];
    const pct = Math.max(0, Math.min(100, w.utilization));
    const rounded = Math.round(pct);
    logUsage(k, label, pct, w.status);
    // Focus (or a tap) shows the popover, not just hover.
    const div = h('div', {
      class: `meter${pct >= 90 || w.status === 'rejected' ? ' bad' : pct >= 75 || w.status === 'allowed_warning' ? ' warn' : ''}`,
      tabindex: 0, role: 'meter', 'aria-valuenow': rounded, 'aria-valuemin': 0, 'aria-valuemax': 100,
      'data-label': label, 'data-pct': rounded, 'data-resets': w.resets_at || ''
    }, h('span', {}, label), h('div', { class: 'meter-track' }, h('div', { class: 'meter-fill' })),
      h('div', { class: 'meter-tip', role: 'tooltip' }, h('strong', {}, `${label}: ${rounded}% used`), h('span', { class: 'meter-reset' })));
    div.querySelector('.meter-fill').style.width = `${pct}%`;
    return div;
  }));
  tickUsage();
}

// Reset times count down, so refresh their wording without rebuilding the meters (that would
// close an open popover).
function tickUsage() {
  for (const div of els.usage.querySelectorAll('.meter')) {
    const reset = resetText(div.dataset.resets);
    div.querySelector('.meter-reset').textContent = reset;
    div.setAttribute('aria-label', `${div.dataset.label}: ${div.dataset.pct}% used. ${reset}`);
  }
}
setInterval(tickUsage, 30 * 1000);

function resetText(iso) {
  if (!iso) return 'Reset time not reported';
  const at = new Date(iso);
  const left = at - Date.now();
  if (Number.isNaN(left)) return 'Reset time not reported';
  if (left <= 0) return 'Resetting now';
  const when = at.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `Resets ${when} (in ${duration(left)})`;
}

function duration(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'under a minute';
  const d = Math.floor(mins / 1440), hr = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  return `${m}m`;
}
