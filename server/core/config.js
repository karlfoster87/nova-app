// Loads config from DATA_DIR/config.json, creating a default on first run.
// The same code serves both deployments; only this file differs between them.
// Settings are grouped into sections so each area can grow without crowding the others.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold } from './paths.js';

// The Nova folder (package.json, server/, public/), and the data folder, which is relative to
// the working folder unless NOVA_DATA_DIR says otherwise.
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = path.resolve(process.env.NOVA_DATA_DIR || './data');
export const VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version; // shown in the header

// Nova's own Claude Code folder: its sign-in and transcripts, apart from any
// Claude Code the same OS user runs. Set on this process too, because in-process SDK
// functions (getSessionMessages) read it. OLD_CLAUDE_DIR is where transcripts used to live.
export const CLAUDE_DIR = path.join(DATA_DIR, 'claude');
const inherited = process.env.CLAUDE_CONFIG_DIR && path.resolve(process.env.CLAUDE_CONFIG_DIR);
export const OLD_CLAUDE_DIR = inherited && inherited !== CLAUDE_DIR ? inherited : path.join(os.homedir(), '.claude');
fs.mkdirSync(CLAUDE_DIR, { recursive: true, mode: 0o700 });
process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;

const defaults = {
  server: {
    // 'local'  = work machine: binds to 127.0.0.1, cookies not marked Secure.
    // 'remote' = home LXC behind Cloudflare Tunnel: binds 0.0.0.0, Secure cookies.
    mode: 'local',
    host: null,           // null = derive from mode
    port: 8484
  },
  paths: {
    brainDir: path.join(DATA_DIR, 'brain'),
    profilesDir: null     // null = <brainDir>/profiles
  },
  claude: {
    settingSources: ['project', 'local']  // the brain's .claude governs; never add 'user'
  },
  models: {
    hidden: [],
    defaultModel: null,
    defaultEffort: 'high',
    showThinking: true    // stream a summary of Claude's thinking (display: 'summarized'); false leaves it out
  },
  chats: {
    idleMinutes: 30       // close idle chat processes after this long
  },
  updates: {
    checkHours: 24,       // how often to look for a new Agent SDK on npm and a new Nova on GitHub; 0 = never. Installing always needs an admin.
    appRepo: 'karlfoster87/nova-app', // GitHub owner/name Nova updates itself from; '' turns app updates off
    appBranch: 'main'
  },
  uploads: {
    maxMB: 25,            // per file
    maxFiles: 10,         // per message
    keepUnsentHours: 24   // files added in the composer but never sent are deleted after this
  },
  voice: {
    // A Piper text-to-speech server Nova relays spoken replies through, so they sound the same
    // on every device: http://host:port (Piper's HTTP server) or tcp://host:port (Wyoming, e.g.
    // Home Assistant's Piper). '' = browsers use their own voices.
    piperUrl: '',
    piperVoice: ''        // e.g. 'en_GB-alba-medium'; '' = the server's default voice
  },
  views: {
    // Access for user profiles an admin hasn't set: 'none' | 'read' | 'edit'. A view
    // missing here is 'none'. Admins always have edit.
    // Tasks and notes are each profile's own, so users can edit them by default.
    userDefaults: { brain: 'read', tasks: 'edit', notes: 'edit' }
  },
  brain: {
    // Hidden from the brain viewer, on top of .git and node_modules. A pattern without a
    // slash matches any file or folder name; with a slash, a path from the brain root.
    // * matches within a name, ** across folders.
    ignore: ['.obsidian', '.trash', '.DS_Store', 'Thumbs.db', 'desktop.ini', '~$*'],
    adminOnly: ['.claude'],   // only admins may edit here: these files steer every chat
    maxViewKB: 2048,          // larger files are download-only
    maxEditKB: 1024,          // larger files are read-only in Nova
    maxZipMB: 500,            // folder downloads above this are refused
    maxUploadMB: 100,         // per uploaded file
    trashDir: '.trash'        // deleted files and folders move here (as Obsidian does); always hidden
  },
  security: {
    sessionDays: 30,
    maxAttempts: 5,       // failed passwords or PINs per profile...
    lockoutMinutes: 15    // ...within this window before sign-in pauses
  }
};

// v0.1 files were flat. Map each old key to its section so older files keep working.
const LEGACY = {
  mode: ['server', 'mode'], host: ['server', 'host'], port: ['server', 'port'],
  brainDir: ['paths', 'brainDir'], profilesDir: ['paths', 'profilesDir'],
  settingSources: ['claude', 'settingSources'],
  hiddenModels: ['models', 'hidden'], defaultModel: ['models', 'defaultModel'], defaultEffort: ['models', 'defaultEffort'],
  idleMinutes: ['chats', 'idleMinutes']
};

function migrate(raw) {
  let changed = false;
  for (const [key, [section, name]] of Object.entries(LEGACY)) {
    if (!(key in raw)) continue;
    raw[section] = { ...raw[section], [name]: raw[key] };
    delete raw[key];
    changed = true;
  }
  if ('auth' in raw) { delete raw.auth; changed = true; } // auth method: replaced by sign-in
  return changed;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const configPath = path.join(DATA_DIR, 'config.json');

if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2));

function readOnDisk() {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (migrate(raw)) {
    fs.copyFileSync(configPath, path.join(DATA_DIR, 'config.v1.json.bak'));
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
    console.log('config.json moved to the sectioned layout; the old file is saved as config.v1.json.bak');
  }
  return raw;
}

const onDisk = readOnDisk();
export const config = {};
for (const section of new Set([...Object.keys(defaults), ...Object.keys(onDisk)])) {
  config[section] = { ...defaults[section], ...onDisk[section] };
}
config.server.host ??= config.server.mode === 'remote' ? '0.0.0.0' : '127.0.0.1';
config.paths.profilesDir ??= path.join(config.paths.brainDir, 'profiles');
fs.mkdirSync(config.paths.brainDir, { recursive: true });

// Chats and categories belong to the brain folder they were made in. The key is the
// folder's full path, normalised so "C:\Brain\", "c:/brain" and "C:/Brain" match on
// Windows, where paths ignore case. It is fixed for the life of the process: changing
// the brain folder restarts Nova.
export function brainKey(dir) {
  return fold(path.resolve(dir).split(path.sep).join('/').replace(/\/+$/, ''));
}
export const BRAIN = brainKey(config.paths.brainDir);
fs.mkdirSync(config.paths.profilesDir, { recursive: true });

// Merge a patch into one section, in memory and on disk. Derived values (host,
// profilesDir) stay out of the file because it's re-read rather than dumped from memory.
export function saveConfig(section, patch) {
  Object.assign(config[section], patch);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  raw[section] = { ...raw[section], ...patch };
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
}

// Environment handed to Claude Code processes. It signs in only from Nova's Claude folder
// (CLAUDE_CONFIG_DIR, set above): credentials inherited from the host would override that
// sign-in, possibly with another account, so they're removed.
export function agentEnv() {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
  return env;
}

export function profileDirPath(profile) { return path.join(config.paths.profilesDir, profile); }

export function profileDir(profile) {
  const dir = profileDirPath(profile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'),
      `# ${profile}\n\nNotes specific to the ${profile} profile. Nova can read and edit this folder during chats in this profile.\n`);
  }
  return dir;
}
