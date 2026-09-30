// Signing Nova in to Claude. Nova runs the bundled Claude Code's own
// `auth login` and only relays the sign-in link and the code the admin pastes back:
// the binary exchanges, stores and renews the credentials in Nova's Claude folder,
// so Nova never sees a token.
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { agentEnv } from '../core/config.js';
import { UserError } from '../core/errors.js';

const require = createRequire(import.meta.url);
const METHODS = { claudeai: '--claudeai', console: '--console' };
const LINK_WAIT = 20_000, CODE_WAIT = 60_000, FLOW_LIFE = 10 * 60_000;

// The same binary the SDK runs: its platform package, and on Linux the glibc build
// first unless this runtime has no glibc (as the SDK decides).
export function claudeBinary() {
  const { platform, arch } = process;
  const name = `claude${platform === 'win32' ? '.exe' : ''}`;
  const base = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  let dirs = [base];
  if (platform === 'linux') {
    const musl = process.report?.getReport?.().header?.glibcVersionRuntime === undefined;
    dirs = musl ? [`${base}-musl`, base] : [base, `${base}-musl`];
  }
  for (const d of dirs) { try { return require.resolve(`${d}/${name}`); } catch {} }
  throw new UserError(`Claude Code isn't installed for ${platform}-${arch}. Run npm install in the Nova folder, then try again.`, 500);
}

// The link comes inside an OSC 8 hyperlink escape, so escapes go before looking for it.
const plain = (s) => s.replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
function findLink(text) {
  for (const m of plain(text).matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try { if (/(^|\.)(claude\.com|claude\.ai|anthropic\.com)$/.test(new URL(m[0]).hostname)) return m[0]; } catch {}
  }
  return null;
}
const lastLine = (text) => plain(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';

let flow = null; // { proc, method, url, output, exited: Promise<number|null>, code, timer }

export function signinStatus() {
  return flow && flow.code === undefined ? { method: flow.method, url: flow.url } : null;
}

export function cancelSignin() {
  if (!flow) return;
  clearTimeout(flow.timer);
  if (flow.code === undefined) flow.proc.kill();
  flow = null;
}

export async function startSignin(method) {
  if (!METHODS[method]) throw new UserError('Choose Claude or Anthropic Console to sign in with.');
  cancelSignin();
  const proc = spawn(claudeBinary(), ['auth', 'login', METHODS[method]], {
    env: { ...agentEnv(), BROWSER: 'none' }, // the link goes to the admin's browser, not the server's
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  proc.stdin.on('error', () => {}); // EPIPE if it has already exited; its exit code reports that
  const f = { proc, method, url: null, output: '', code: undefined };
  f.exited = new Promise((resolve) => {
    proc.on('exit', (code) => { f.code = code; resolve(code); });
    proc.on('error', (err) => { f.output += `\n${err.message}`; f.code = null; resolve(null); });
  });
  flow = f;
  f.timer = setTimeout(() => { if (flow === f) cancelSignin(); }, FLOW_LIFE);
  f.timer.unref();

  f.url = await new Promise((resolve) => {
    const onData = (d) => { f.output += d; const url = findLink(f.output); if (url) done(url); };
    const done = (url) => { clearTimeout(t); proc.stdout.off('data', onData); proc.stderr.off('data', onData); resolve(url); };
    const t = setTimeout(() => done(null), LINK_WAIT);
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    f.exited.then(() => done(findLink(f.output)));
  });
  // Keep collecting output: the result line comes after the code is sent.
  proc.stdout.on('data', (d) => { f.output += d; });
  proc.stderr.on('data', (d) => { f.output += d; });
  if (!f.url || f.code !== undefined) {
    console.error('Claude sign-in gave no link. Output:', plain(f.output));
    cancelSignin();
    throw new UserError('Claude Code didn\'t give a sign-in link. The server log has its output. Try again, or run npm run claude-login on the host.', 502);
  }
  return { method, url: f.url };
}

export async function submitCode(input) {
  const code = String(input || '').trim();
  const f = flow;
  if (!f || f.code !== undefined) throw new UserError('No sign-in is waiting for a code. Start signing in again.', 409);
  if (!code || code.length > 2000 || /\s/.test(code)) throw new UserError('Paste the code exactly as the sign-in page shows it.');
  f.output = '';
  f.proc.stdin.write(`${code}\n`);
  const exit = await Promise.race([f.exited, new Promise((r) => setTimeout(() => r('timeout'), CODE_WAIT))]);
  if (flow === f) { clearTimeout(f.timer); flow = null; }
  if (exit === 0) return;
  if (exit === 'timeout') f.proc.kill();
  const said = exit === 'timeout' ? 'Claude Code didn\'t answer within a minute.' : lastLine(f.output) || `Claude Code stopped (exit ${exit}).`;
  console.error('Claude sign-in failed:', said);
  throw new UserError(`Sign-in didn't work: ${said} Start again and paste the whole code.`, 400);
}

export function signOut() {
  cancelSignin();
  return new Promise((resolve, reject) => {
    execFile(claudeBinary(), ['auth', 'logout'], { env: agentEnv(), timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve();
      console.error('Claude sign-out failed:', err.message, stdout, stderr);
      reject(new UserError('Signing out didn\'t work. The server log has the details.', 500));
    });
  });
}
