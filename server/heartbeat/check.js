// A schedule's check script: plain code that runs before Nova does, so a schedule that usually
// finds nothing costs nothing. It might read new mail through Outlook's COM objects, or the last
// hour's Home Assistant events, filtered. Whatever it prints is the run's input; when it prints
// nothing, there is nothing to do and the run is skipped without starting a model. A failure (a
// non-zero exit or a timeout) is reported rather than passed on.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from '../core/config.js';
import { UserError } from '../core/errors.js';

export const SCRIPT_TYPES = /\.(ps1|sh|bash|py|js|mjs|cjs|bat|cmd)$/i;
const TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT = 20000; // characters passed to Nova; more is cut with a note

// A check script's full path, from the pane or Nova's tool: absolute, or relative to the brain
// folder, and an existing script file. null clears it.
export function checkScriptPath(value) {
  if (value == null || String(value).trim() === '') return null;
  const raw = String(value).trim().replace(/^["']|["']$/g, '');
  const full = path.resolve(config.paths.brainDir, raw);
  if (!SCRIPT_TYPES.test(full)) throw new UserError(`${path.basename(full)} isn't a script Nova can run. Use a .ps1, .sh, .py, .js, .bat or .cmd file.`);
  let file = false;
  try { file = fs.statSync(full).isFile(); } catch { /* reported below */ }
  if (!file) throw new UserError(`There's no script at ${full}. Check the path, or create the script first.`);
  return full;
}

// How to start a script of each kind. PowerShell is told to write UTF-8, so subjects and names
// with accents come through intact.
function command(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.ps1') {
    const run = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & '${file.replace(/'/g, '\'\'')}'; exit $LASTEXITCODE`;
    return [process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', run]];
  }
  if (ext === '.sh' || ext === '.bash') return ['bash', [file]];
  if (ext === '.py') return [process.platform === 'win32' ? 'python' : 'python3', [file]];
  if (ext === '.bat' || ext === '.cmd') return ['cmd.exe', ['/d', '/c', file]];
  return [process.execPath, [file]];
}

// Runs the script in the brain folder. Resolves { output } (trimmed, '' when it found nothing)
// or { error } saying what went wrong.
export function runCheck(file) {
  if (!fs.existsSync(file)) return Promise.resolve({ error: `its check script is missing (${file})` });
  const [cmd, args] = command(file);
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: config.paths.brainDir, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const why = err.killed ? 'it took longer than 2 minutes' : err.code === 'ENOENT' ? `${cmd} isn't installed`
            : `it stopped with ${err.code != null ? `exit code ${err.code}` : 'an error'}`;
          const said = String(stderr || stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
          resolve({ error: `its check script failed: ${why}${said ? ` (${said})` : ''}` });
          return;
        }
        const out = String(stdout || '').trim();
        resolve({ output: out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n[…cut: the script printed ${out.length} characters]` : out });
      });
  });
}
