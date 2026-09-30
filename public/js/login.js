// The theme picked in Settings applies here too (dark unless this browser chose otherwise).
try {
  const t = JSON.parse(localStorage.getItem('nova.theme'));
  if (t === 'light' || (t === 'system' && matchMedia('(prefers-color-scheme: light)').matches)) document.documentElement.dataset.scheme = 'light';
} catch {}
const form = document.getElementById('loginForm');
const error = document.getElementById('error');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  const data = Object.fromEntries(new FormData(form));
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  if (res.ok) location.href = '/';
  else error.textContent = (await res.json()).error || 'Sign-in failed.';
});
