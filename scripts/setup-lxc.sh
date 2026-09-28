#!/usr/bin/env bash
# Installs or repairs Nova in a Debian or Ubuntu LXC. Run as root inside the container; it
# downloads the latest Nova from GitHub itself, so the container needs no git and no copy:
#
#   curl -fsSL https://raw.githubusercontent.com/karlfoster87/nova-app/main/scripts/setup-lxc.sh | bash -s -- --brain /mnt/brain
#
# It installs Node 24 (NodeSource) unless Node 22.13+ is already there, plus rsync and git (for
# the brain viewer's commits); creates the system user "nova" (no sudo, no login shell); puts
# the app in /opt/nova and records which commit it is, so Nova can update itself from GitHub
# afterwards (Settings, Updates); installs packages as nova; writes /opt/nova/data/config.json
# on first run (mode remote, and --brain / --port if given); installs the systemd unit and a
# "nova" helper command; then (re)starts Nova and waits for it to answer. /opt/nova/data
# (config, database, sign-in, logs) is never touched, so running it again is a safe repair.
set -euo pipefail

APP=/opt/nova
DATA=$APP/data
HOME_DIR=/home/nova
SERVICE=/etc/systemd/system/nova.service
HELPER=/usr/local/bin/nova
REPO=karlfoster87/nova-app
BRANCH=main
BRAIN=''
PORT=''
FROM_GITHUB=''
COMMIT=''

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'setup-lxc: %s\n' "$*" >&2; exit 1; }
as_nova() { runuser -u nova -- env HOME="$HOME_DIR" NOVA_DATA_DIR="$DATA" "$@"; }
usage() {
  cat <<'EOF'
Usage (as root in the container):
  curl -fsSL https://raw.githubusercontent.com/karlfoster87/nova-app/main/scripts/setup-lxc.sh | bash -s -- [options]
  bash scripts/setup-lxc.sh [options]            from a Nova folder, installs that folder instead

Options:
  --brain <folder>        the brain's mount point (first setup only)
  --port <number>         port, default 8484 (first setup only)
  --repo <owner/name>     GitHub repository to install and update from, default karlfoster87/nova-app
  --branch <name>         branch, default main
  --from-github           download from GitHub even when run from a Nova folder
EOF
}

# Run from a Nova folder, it installs that folder; piped from curl (or with --from-github),
# it downloads the branch from GitHub.
SCRIPT=${BASH_SOURCE[0]:-}
SRC=''
if [ -n "$SCRIPT" ] && [ -f "$SCRIPT" ] && [ -f "$(dirname "$SCRIPT")/../server/launcher.js" ]; then
  SRC=$(cd "$(dirname "$SCRIPT")/.." && pwd)
fi

while [ $# -gt 0 ]; do
  case $1 in
    --brain) BRAIN=${2:-}; shift 2 || fail '--brain needs a folder.' ;;
    --port) PORT=${2:-}; shift 2 || fail '--port needs a number.' ;;
    --repo) REPO=${2:-}; shift 2 || fail '--repo needs owner/name.' ;;
    --branch) BRANCH=${2:-}; shift 2 || fail '--branch needs a name.' ;;
    --from-github) FROM_GITHUB=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "Unknown option $1." ;;
  esac
done
[ -n "$FROM_GITHUB" ] && SRC=''

[ "$(id -u)" = 0 ] || fail 'Run this as root inside the container.'
command -v apt-get >/dev/null || fail 'This script expects Debian or Ubuntu (apt-get).'
command -v systemctl >/dev/null || fail 'This script expects systemd.'
[ -z "$SRC" ] || [ -f "$SRC/package-lock.json" ] || fail "$SRC doesn't look like the Nova folder."
[[ $REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail '--repo must look like owner/name.'
[ -z "$PORT" ] || [[ $PORT =~ ^[0-9]+$ ]] || fail '--port must be a number.'
[ -z "$BRAIN" ] || [ -d "$BRAIN" ] || fail "$BRAIN doesn't exist. Bind-mount the brain into the container first (README, Proxmox step 2), then run this again."

step 'Node.js'
node_ok() { command -v node >/dev/null && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git rsync >/dev/null
if node_ok; then
  echo "Node $(node -v) is already installed."
else
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
  node_ok || fail "Node 22.13 or later still isn't available (found $(node -v 2>/dev/null || echo none))."
  echo "Installed Node $(node -v)."
fi
NODE=$(command -v node)

step 'Nova code'
if [ -n "$SRC" ]; then
  echo "Installing the Nova folder $SRC."
else
  # The branch's latest commit, downloaded as it is on GitHub. Recording that commit is what
  # lets Nova tell, later, whether GitHub has something newer to update to.
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  COMMIT=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/commits/$BRANCH" |
    node -e 'let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => console.log(JSON.parse(s).sha))') ||
    fail "Couldn't find branch $BRANCH of github.com/$REPO. Check the name, and that the repository is public."
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$COMMIT" | tar -xz -C "$TMP" --strip-components=1 ||
    fail "Couldn't download Nova from GitHub."
  [ -f "$TMP/server/launcher.js" ] && [ -f "$TMP/package-lock.json" ] || fail "github.com/$REPO doesn't look like Nova."
  SRC=$TMP
  echo "Downloaded github.com/$REPO at ${COMMIT:0:7}."
fi

step 'User'
if id nova >/dev/null 2>&1; then
  echo 'User nova already exists.'
else
  useradd --system --create-home --home-dir "$HOME_DIR" --shell /usr/sbin/nologin nova
  echo 'Created user nova (no sudo, no login shell).'
fi

step 'App files'
install -d -o nova -g nova -m 0755 "$APP"
if [ "$SRC" -ef "$APP" ]; then
  echo "Running from $APP itself, so there's nothing to copy."
else
  exclude=(--exclude=/data/ --exclude=/node_modules/ --exclude=/.git/ --exclude=/.claude/)
  # Settings can update the Agent SDK in place, rewriting package.json and the lockfile here.
  # Keep them when they pin a newer SDK than this copy, so an update never downgrades it.
  sdk() { node -p "require('$1/package.json').dependencies['@anthropic-ai/claude-agent-sdk']" 2>/dev/null || true; }
  here=$(sdk "$APP"); incoming=$(sdk "$SRC")
  if [ -n "$here" ] && [ "$here" != "$incoming" ] && [ "$(printf '%s\n%s\n' "$here" "$incoming" | sort -V | tail -n 1)" = "$here" ]; then
    echo "Keeping Agent SDK $here, installed from Settings (this copy has $incoming)."
    exclude+=(--exclude=/package.json --exclude=/package-lock.json)
  fi
  rsync -a --delete "${exclude[@]}" --chown=nova:nova "$SRC/" "$APP/"
  echo "Copied the app to $APP."
  # Record which commit this is, so Nova's own updates (Settings, Updates) can tell whether
  # GitHub has something newer: the downloaded commit, or a local folder's clean git HEAD.
  # Without one, Nova only offers updates with a higher version number.
  if [ -z "$COMMIT" ]; then
    srcgit() { git -c safe.directory='*' -C "$SRC" "$@" 2>/dev/null; }
    if head=$(srcgit rev-parse HEAD) && [ -z "$(srcgit status --porcelain --untracked-files=no)" ]; then COMMIT=$head; fi
  fi
  if [ -n "$COMMIT" ]; then
    printf '{ "commit": "%s", "version": "%s" }\n' "$COMMIT" "$(node -p "require('$APP/package.json').version")" > "$APP/build.json"
    chown nova:nova "$APP/build.json"
    echo "Nova will update itself from github.com/$REPO ($BRANCH) from commit ${COMMIT:0:7} on."
  else
    echo "This folder isn't a clean git checkout, so Nova will only offer updates with a higher version number."
  fi
fi
chown -R nova:nova "$APP"

step 'Packages'
cd "$APP"
as_nova npm ci --omit=dev --no-audit --no-fund
[ -f node_modules/@anthropic-ai/claude-agent-sdk/package.json ] || fail "The Agent SDK didn't install. See npm's output above."
# The lockfile may have been made on Windows; this is the Linux build of Claude Code the SDK runs.
compgen -G 'node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude' >/dev/null ||
  fail "Claude Code for Linux didn't install with the Agent SDK. Try: cd $APP && runuser -u nova -- env HOME=$HOME_DIR npm install --no-audit --no-fund"

step 'Config'
install -d -o nova -g nova -m 0700 "$DATA"
if [ -f "$DATA/config.json" ]; then
  echo "Keeping $DATA/config.json."
  [ -z "$BRAIN$PORT" ] || echo "--brain and --port only apply on first setup. Change the brain in Settings, or edit $DATA/config.json."
  mode=$(node -p "require('$DATA/config.json').server?.mode || 'local'" 2>/dev/null || echo unknown)
  [ "$mode" = remote ] || echo "Note: server.mode is \"$mode\". Behind Cloudflare Tunnel it should be \"remote\" (Secure cookies)."
else
  # Self-updates follow the repository this was installed from; the default needs no entry.
  as_nova node -e '
    const [file, brain, port, repo, branch] = process.argv.slice(1);
    const config = { server: { mode: "remote" } };
    if (port) config.server.port = Number(port);
    if (brain) config.paths = { brainDir: brain };
    if (repo !== "karlfoster87/nova-app" || branch !== "main") config.updates = { appRepo: repo, appBranch: branch };
    require("fs").writeFileSync(file, JSON.stringify(config, null, 2) + "\n");' "$DATA/config.json" "$BRAIN" "$PORT" "$REPO" "$BRANCH"
  echo "Wrote $DATA/config.json (mode remote${BRAIN:+, brain $BRAIN}${PORT:+, port $PORT})."
fi
brain=$(node -p "require('$DATA/config.json').paths?.brainDir || ''" 2>/dev/null || true)
if [ -n "$brain" ] && ! runuser -u nova -- test -r "$brain" -a -w "$brain" -a -x "$brain"; then
  echo "Warning: nova can't read and write $brain. In an unprivileged container, the folder's owner on the Proxmox host must be the container's nova UID plus 100000 (see: id nova)."
fi

step 'Service'
cat > "$SERVICE.new" <<EOF
# Made by scripts/setup-lxc.sh. Run that again rather than editing this.
[Unit]
Description=Nova
Wants=network-online.target
After=network-online.target

[Service]
User=nova
Group=nova
WorkingDirectory=$APP
Environment=NOVA_DATA_DIR=$DATA
ExecStart=$NODE server/launcher.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
if cmp -s "$SERVICE.new" "$SERVICE"; then rm "$SERVICE.new"; else mv "$SERVICE.new" "$SERVICE"; echo "Installed $SERVICE."; fi
systemctl daemon-reload
systemctl enable --quiet nova

cat > "$HELPER" <<EOF
#!/bin/sh
# Nova's host commands, run as the nova user. Made by scripts/setup-lxc.sh.
#   nova add-profile <name> [--admin]      nova claude-login [--console | status | logout]
#   nova logs | status | restart | stop | start
set -e
cd $APP
case "\${1:-}" in
  add-profile|claude-login) cmd=\$1; shift; exec runuser -u nova -- env HOME=$HOME_DIR NOVA_DATA_DIR=$DATA npm run -s "\$cmd" -- "\$@" ;;
  logs) exec journalctl -u nova -f ;;
  status|restart|stop|start) exec systemctl "\$1" nova ;;
  *) sed -n '3,4p' "\$0"; exit 1 ;;
esac
EOF
chmod 0755 "$HELPER"
echo "Installed the nova command ($HELPER)."

systemctl restart nova
port=$(node -p "require('$DATA/config.json').server?.port || 8484")
up=''
for _ in $(seq 60); do
  if curl -fs -o /dev/null "http://127.0.0.1:$port/api/health"; then up=1; break; fi # quiet while it starts
  sleep 0.5
done
[ -n "$up" ] || fail "Nova didn't answer on port $port within 30 seconds. See: journalctl -u nova -n 50"

step 'Done'
cat <<EOF
Nova is running on port $port and starts with the container.

Next, if you haven't already:
  1. Create your admin profile:      nova add-profile <name> --admin
  2. Point cloudflared at http://127.0.0.1:$port (README, Remote access).
  3. Open Nova, sign in, then Settings, Claude: Sign in with Claude.
The Proxmox firewall rules are set on the host, not here (README, Proxmox step 7).

Updates: Settings, Updates in Nova (from GitHub). Logs: nova logs
To repair the install, run this same command again.
EOF
