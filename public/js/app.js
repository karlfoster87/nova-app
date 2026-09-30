// Nova's browser app. index.html loads this module and it starts everything else:
//   state.js     what the page knows, shared by the modules below
//   shell/       theme, header, drawers, views and routes, the profile, restart screen, installed app
//   chat/        the Chats view: controller, socket, transcript, composer, pickers, sidebar
//   presence/    the right-hand panel: avatars and the activity log
//   settings/    the Settings dialog, one module per tab, and the profile switcher
//   views/       Brain, Tasks and Notes, loaded when first opened
//   lib/         small shared helpers: DOM, API calls, storage, markdown, dialogs, menus
import { $ } from './lib/dom.js';
import { state } from './state.js';
import './shell/theme.js';       // first, so the page never flashes the wrong theme
import './shell/drawers.js';
import './presence/panel.js';    // listens for 'nova:presence' and 'nova:log'
import { openLog } from './presence/log.js';
import { refreshMe } from './shell/profile.js';
import { goTo, routeFromHash } from './shell/views.js';
import { startChats, pwa } from './chat/chats.js';
import { openSettings } from './settings/dialog.js';
import { openSwitcher } from './settings/switcher.js';

$('settingsBtn').addEventListener('click', () => openSettings());
$('profileBtn').addEventListener('click', () => openSwitcher());

(async function boot() {
  await refreshMe();
  if (!state.me) return;
  openLog(state.me.profile);
  state.meta = state.me.meta;
  await startChats();
  await goTo(routeFromHash());
  pwa.listenForLaunches(); // after routing is ready; relaunches and shortcuts route into this window
})();
