#!/usr/bin/env bash
# Sets up or updates Nova in a Debian or Ubuntu LXC. Run as root inside
# the container, from a copy of the Nova folder (node_modules and data aren't needed):
#
#   bash scripts/setup-lxc.sh [--brain /mnt/brain] [--port 8484]
#
# It installs Node 24 (NodeSource) unless Node 22.13+ is already there, plus git and rsync;
# creates the system user "nova" (no sudo, no login shell); copies the app to /opt/nova;
# installs packages as nova; writes /opt/nova/data/config.json on first run (mode remote,
# and --brain / --port if given); installs the systemd unit and a "nova" helper command;
# then (re)starts Nova and waits for it to answer. Run it again with a newer copy to update:
# code is replaced, while /opt/nova/data (config, database, sign-in, logs) is never touched.
set -euo pipefail

APP=/opt/nova
DATA=$APP/data
HOME_DIR=/home/nova
SERVICE=/etc/systemd/system/nova.service
HELPER=/usr/local/bin/nova
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BRAIN=''
PORT=''

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'setup-lxc: %s\n' "$*" >&2; exit 1; }
as_nova() { runuser -u nova -- env HOME="$HOME_DIR" NOVA_DATA_DIR="$DATA" "$@"; }

while [ $# -gt 0 ]; do
  case $1 in
    --brain) BRAIN=${2:-}; shift 2 || fail '--brain needs a folder.' ;;
    --port) PORT=${2:-}; shift 2 || fail '--port needs a number.' ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) fail "Unknown option $1. Use --brain <folder> and --port <number>." ;;
  esac
done

[ "$(id -u)" = 0 ] || fail 'Run this as root inside the container.'
command -v apt-get >/dev/null || fail 'This script expects Debian or Ubuntu (apt-get).'
command -v systemctl >/dev/null || fail 'This script expects systemd.'
[ -f "$SRC/server/launcher.js" ] && [ -f "$SRC/package-lock.json" ] || fail "$SRC doesn't look like the Nova folder."
[ -z "$PORT" ] || [[ $PORT =~ ^[0-9]+$ ]] || fail '--port must be a number.'
[ -z "$BRAIN" ] || [ -d "$BRAIN" ] || fail "$BRAIN doesn't exist. Bind-mount the brain into the container first (README, Home server step 3), then run this again."

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
  echo "Copied $SRC to $APP."
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
  as_nova node -e '
    const [file, brain, port] = process.argv.slice(1);
    const config = { server: { mode: "remote" } };
    if (port) config.server.port = Number(port);
    if (brain) config.paths = { brainDir: brain };
    require("fs").writeFileSync(file, JSON.stringify(config, null, 2) + "\n");' "$DATA/config.json" "$BRAIN" "$PORT"
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
The Proxmox firewall rules are set on the host, not here (README, Home server step 6).

Logs: nova logs      Update: copy a newer Nova folder here and run this script again.
EOF
