// Full-screen notice while the server restarts (a new brain folder, an update). It polls
// /api/health and reloads once a new process answers (its boot ID differs from oldBoot);
// after a minute it offers a manual reload.
import { $ } from '../lib/dom.js';

export function showRestarting(message = 'Nova is restarting. This page reloads by itself when it\'s back.', oldBoot = null) {
  const dlg = $('restarting');
  if (dlg.open) return;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('restartText').textContent = message;
  $('restartActions').hidden = true;
  dlg.addEventListener('cancel', (e) => e.preventDefault()); // Esc can't dismiss it
  $('restartReload').onclick = () => location.reload();
  dlg.showModal();

  const started = Date.now();
  let wentDown = false;
  const poll = async () => {
    let up = false, boot = null;
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      up = res.ok;
      boot = up ? (await res.json()).boot : null;
    } catch { up = false; }
    if (!up) wentDown = true;
    const restarted = oldBoot ? boot && boot !== oldBoot : wentDown;
    const elapsed = Date.now() - started;
    // Show the notice for at least 3 seconds so it can be read.
    if (up && elapsed >= 3000 && (restarted || elapsed >= 15000)) { location.reload(); return; }
    if (elapsed > 60000) {
      $('restartText').textContent = 'Nova hasn\'t come back after a minute. Check the terminal or service it runs under, then reload.';
      $('restartActions').hidden = false;
      return;
    }
    setTimeout(poll, 1000);
  };
  setTimeout(poll, 1000);
}
