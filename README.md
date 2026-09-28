# Nova

A self-hosted chat console for Claude, built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Nova is a web app you install as a PWA. It gives Claude Code's agent a proper interface over a folder of markdown notes (your "brain"), with separate profiles, a brain viewer, tasks and notes, and no IDE needed.

One codebase runs in two places:

- **Windows:** a background process on your own machine, reached on `127.0.0.1` and installed as an Edge app.
- **Proxmox LXC:** an always-on service in an unprivileged container, reached remotely through Cloudflare Tunnel.

Version 0.2. Runs on Node 22.13 or newer (24 LTS recommended), with `@anthropic-ai/claude-agent-sdk` 0.3.283.

## Features

**Chat**
- Streaming replies with markdown, collapsible thinking, and tool calls shown with their results
- Sub-agents nested under the call that started them, tracked until they finish, including background agents
- Permission prompts: allow once, allow for this chat, always allow (remembered per profile), or deny. Claude's multiple-choice questions are answered inline
- Per-chat model, effort and permission mode (ask first, auto-accept edits, auto, plan only), switched without restarting the chat
- File and image attachments
- Several chats at once, each with its own Claude Code process. Idle ones close after 30 minutes, and history and sessions resume after a restart
- Chats organised into categories, with drag and drop, rename, move, delete and title search

**Claude**
- Sign in to Claude from Settings with a Claude subscription or an Anthropic Console account. Claude Code's own login runs on the server, you approve in any browser, and it keeps the sign-in renewed. Nova never handles a token
- Nova's sign-in is separate from any Claude Code you use yourself on the same machine, so the two can use different accounts
- Plan usage bars (session and weekly) with reset times, for subscription sign-ins
- Model list straight from the SDK, with hidden models and defaults set in Settings
- Agent SDK updates from Settings: checked on a timer, installed only when an admin asks, and tested before Nova restarts, with automatic rollback
- The brain's own `CLAUDE.md` and `.claude/` rules, skills and agents load into every chat, as they do in Claude Code. User-level settings and cloud memory are never loaded

**Profiles**
- Several profiles for one person (for example work, home, phone), each with its own chats, notes folder, tasks and notes
- Admin and user roles, with at least one admin always kept. Access to each view (none, read, or read and edit) is set per profile
- Profile switcher with profile pictures or initials. Switch with a password or a 4-digit PIN; the PIN is checked as you type the last digit
- Extra folders outside the brain (local or network) allowed per profile

**Views**
- **Brain:** browse, read, edit and download the brain. Markdown with `[[wiki links]]` and embeds, images and video, uploads, a trash folder, and git commits on save when the brain is a repository
- **Tasks:** a board of day columns with nesting, states and drag and drop
- **Notes:** coloured sticky notes, active or long-standing

**Interface**
- Neon console design, dark by default with a light option. Responsive down to phone width
- Presence panel with an animated avatar that follows what Claude is doing, sub-agent activity, and an activity log

## Install on Windows

This runs Nova as you, in the background, from sign-in. No admin rights are needed, and your files, mapped drives and network shares all work.

1. Install [Node.js](https://nodejs.org) 22.13 or newer (24 LTS recommended), and Git if you're cloning.
2. Get the code and install packages:
   ```powershell
   git clone <this repository> C:\Nova
   cd C:\Nova
   npm install
   ```
3. Create your admin profile (it asks for a password of at least 12 characters):
   ```powershell
   npm run add-profile -- <name> --admin
   ```
4. Set the brain folder. Step 3 created `data\config.json`. In it, set `paths.brainDir` to your notes folder, for example `{ "paths": { "brainDir": "C:/Notes/Brain" } }`. You can also change it later in Settings.
5. Start Nova in the background, and at every sign-in:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
   ```
   This creates a scheduled task called Nova that runs with no window. It restarts the server within seconds after a crash, and checks every 5 minutes that Nova is running. Output goes to `data\logs\nova.log`. Use `-Stop` to stop it until your next sign-in, and `-Uninstall` to remove the autostart. Neither touches `data\`. If your organisation blocks scheduled tasks, the script falls back to a Startup folder shortcut.
6. Open `http://127.0.0.1:8484` in Edge, sign in, and choose **Apps → Install this site as an app**. To open the window at sign-in too, go to `edge://apps`, open Nova's details and turn on **Start app when you sign in**.
7. In Nova, open **Settings → Claude** and choose **Sign in with Claude**. Open the link, approve, and paste the code back into Nova.

If Nova has to run before anyone signs in, run it as a service instead, with [NSSM](https://nssm.cc) or WinSW, under your own account: `node.exe server\launcher.js`, with the Nova folder as the working directory. A service can't see mapped drive letters, so give extra folders as `\\server\share` paths.

## Install in a Proxmox LXC

1. **Create the container.** Use an unprivileged Debian 12 container. It doesn't need nesting. Memory is a ceiling rather than a reservation, so 4 GB is plenty.
2. **Mount the brain.** Bind-mount the brain, and any shares Nova needs, from the Proxmox host into the container, read-only where you can. In an unprivileged container, the host files must be owned by UID 100000 plus the container UID of the `nova` user (`id nova` shows it once setup has run).
3. **Copy Nova in,** for example to `/root/nova-src`. Leave out `node_modules` and `data`; the container installs its own packages.
4. **Run the setup** as root inside the container:
   ```bash
   bash /root/nova-src/scripts/setup-lxc.sh --brain /mnt/brain
   ```
   It installs Node 24 (from NodeSource), git and rsync, and creates the user `nova` with no sudo and no login shell. It copies the app to `/opt/nova`, installs packages, and writes `/opt/nova/data/config.json` (remote mode, your brain folder). Then it installs and starts the systemd unit `nova`. Add `--port <n>` for a port other than 8484.
5. **Create your admin profile:**
   ```bash
   nova add-profile <name> --admin
   ```
6. **Set up remote access.** Run `cloudflared` in the container (or a separate one) and route a hostname to `http://127.0.0.1:8484`. Put a Cloudflare Access application in front with a long session, around a month, so the installed PWA doesn't bounce to a login page. Access is the front door; Nova's own profile login is the second layer. WebSockets work through the tunnel with no extra settings.
7. **Sign in to Claude.** Open Nova, sign in, and go to **Settings → Claude → Sign in with Claude**. Nothing needs to reach the container for this: you approve in your own browser and paste the code back.
8. **Set the firewall** on the Proxmox host. Allow outbound to `anthropic.com`, `claude.com`, `claude.ai`, npm, `deb.nodesource.com`, the Debian mirrors, Cloudflare and your share hosts. Block the Proxmox host and the rest of the LAN.

The `nova` command runs host tasks as the right user:

| Command | Does |
|---|---|
| `nova add-profile <name> [--admin]` | Create a profile, or reset its password. `--admin` is the way back in if every admin is locked out |
| `nova claude-login [--console \| status \| logout]` | Sign in to Claude from the terminal, when Settings can't be reached (restart afterwards) |
| `nova logs` | Follow the log |
| `nova status \| restart \| stop \| start` | Control the service |

## Updating

- **Windows:** stop Nova (`scripts\install-windows.ps1 -Stop`), update the code (`git pull`), run `npm install`, then run `scripts\install-windows.ps1` again.
- **LXC:** copy the newer code into the container and run `setup-lxc.sh` again. It replaces the code but never touches `/opt/nova/data`, and it keeps an Agent SDK you've updated from Settings rather than downgrade it.
- **Agent SDK:** an admin can update it from **Settings → Updates** on either install.

## Configuration

Everything Nova keeps lives in the data folder (`NOVA_DATA_DIR`, by default `./data`, or `/opt/nova/data` in the LXC):

```
data/
  config.json     settings, in sections: server, paths, claude, models, chats, uploads, views, brain, updates, security
  nova.db         profiles, sign-ins, chat index, categories, approvals, folders, tasks, notes, pictures
  claude/         Nova's own Claude Code folder: its Claude sign-in and chat transcripts
  uploads/        chat attachments, per profile
  logs/           nova.log, when started by the Windows task
```

`claude/` holds a live Claude sign-in, so keep the data folder private, including in backups.

Keys you're most likely to change in `config.json` (any key you leave out keeps its default):

| Key | Default | |
|---|---|---|
| `server.mode` | `local` | `local` binds `127.0.0.1`. `remote` binds all interfaces and marks cookies Secure (for use behind a tunnel) |
| `server.port` | `8484` | |
| `paths.brainDir` | `data/brain` | Your brain folder. Can also be changed in Settings (admins) |
| `chats.idleMinutes` | `30` | Idle chat processes close after this long |
| `views.userDefaults` | brain read, tasks and notes edit | Access for user profiles an admin hasn't set |
| `security.sessionDays` | `30` | Session length |

Each profile's notes live in `<brain>/profiles/<name>/` and are added to that profile's chats.

## Commands

| Command | |
|---|---|
| `npm start` | Run Nova in the foreground (`server/launcher.js`, which restarts it when Settings asks) |
| `npm run add-profile -- <name> [--admin]` | Create a profile or reset its password |
| `npm run claude-login [-- --console \| status \| logout]` | Claude sign-in from the terminal |
| `npm run check` | Syntax check |
| `npm run smoke` | HTTP and WebSocket test of sign-in, profile isolation, access levels and routes. Uses its own server and throwaway data, and sends no prompt |

`scripts/ui-check.cjs` screenshots the UI from desktop to phone widths with [Playwright](https://playwright.dev). Playwright isn't a dependency: install it in a scratch folder and run the script against a throwaway Nova, as its header explains.

## Security

- Every HTTP route and WebSocket message checks the profile; a chat ID alone never grants access. Roles are checked on the server, never inferred from the UI.
- Passwords and PINs are hashed with scrypt, and sign-in and switching are throttled per profile. Sessions are HttpOnly, SameSite=Strict cookies.
- State-changing requests and WebSocket upgrades must come from the same origin.
- A strict Content Security Policy is in place. Model output is rendered with `marked` and sanitised with DOMPurify; everything else is inserted as text.
- File routes resolve paths, following symlinks, and refuse anything outside their allowed folder.
- Nova holds no Claude secret itself. Claude Code keeps the sign-in in `data/claude/`, and the browser only ever sees the account name.
- Anything Claude does, it does as the user running Nova. On the LXC, the container, its firewall and its mounts are the real boundary.

## Project layout

```
server/    Node server: HTTP API and WebSocket (index.js), one Agent SDK session per chat (chat.js),
           Claude sign-in (signin.js), profiles, auth, views, SQLite (db.js), launcher.js
public/    Browser app: native ES modules, no framework or build step
scripts/   add-profile, claude-login, install-windows.ps1, setup-lxc.sh, smoke tests
```

There's no build step and no framework. The only dependencies are the Agent SDK, `ws`, `marked` and `dompurify`.
