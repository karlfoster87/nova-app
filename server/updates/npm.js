// Runs npm with the Node that runs Nova. Services (NSSM, systemd) often start without npm
// on PATH, and npm.cmd needs a shell on Windows, so this finds npm-cli.js and runs it directly.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
export const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function npmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,                                          // set by `npm start`
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),    // Windows installer layout
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js') // Linux and macOS
  ];
  return candidates.find((f) => f && /npm-cli\.js$/.test(f) && fs.existsSync(f)) || null;
}

// Resolves with stdout; rejects with an Error whose message is npm's last useful lines.
export function npm(args, { cwd, timeout = 5 * 60 * 1000 } = {}) {
  const cli = npmCli();
  if (!cli) return Promise.reject(new Error('npm wasn\'t found next to the Node that runs Nova. Install Node with its bundled npm.'));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], { cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const detail = String(stderr || stdout || err.message).trim().split('\n').filter((l) => /\S/.test(l)).slice(-6).join('\n');
        reject(new Error(err.killed ? `npm ${args[0]} timed out.` : detail || `npm ${args[0]} failed.`));
      });
  });
}
