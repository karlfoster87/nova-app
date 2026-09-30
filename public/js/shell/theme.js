// Theme: dark unless this browser picked light or the system's (Settings → Your profile).
// data-theme is the choice; data-scheme is what's showing (system resolved), which the CSS
// and the avatars follow. login.js applies the same choice on the sign-in page.
import { $ } from '../lib/dom.js';
import { store } from '../lib/store.js';

const THEMES = { dark: 'Dark', light: 'Light', system: 'Match the system' };
const systemLight = matchMedia('(prefers-color-scheme: light)');

function applyTheme(theme) {
  const t = THEMES[theme] ? theme : 'dark';
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.scheme = t === 'system' ? (systemLight.matches ? 'light' : 'dark') : t;
  // The installed app colours its window (and, with the title bar hidden, the system's window
  // controls) from theme-color, so it follows the page's background.
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--void').trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}

systemLight.addEventListener('change', () => applyTheme(document.documentElement.dataset.theme));
applyTheme(store.get('theme', 'dark'));

const form = $('themeForm');
form.theme.value = document.documentElement.dataset.theme;
form.addEventListener('submit', (e) => e.preventDefault());
form.theme.addEventListener('change', () => {
  store.set('theme', form.theme.value);
  applyTheme(form.theme.value);
  form.querySelector('.form-status').textContent = `Theme set to ${THEMES[form.theme.value].toLowerCase()} in this browser.`;
});
