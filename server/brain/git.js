// Commits the brain viewer's changes when the brain is a git repository: one commit per save,
// delete or upload batch, authored by the profile. Not a repository, or nothing git tracks:
// skipped silently. The change on disk stands either way; a failed commit is reported, never undone.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { root } from './resolve.js';

// input: written to git's stdin (NUL-separated paths), so a long list never hits the
// command-line length limit on Windows.
function git(args, env = {}, input = null) {
  return new Promise((resolve) => {
    const child = execFile('git', ['--literal-pathspecs', ...args],
      { cwd: root(), timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } },
      (error, stdout, stderr) => resolve({ ok: !error, missing: error?.code === 'ENOENT', out: String(stdout), err: String(stderr) }));
    child.stdin?.on('error', () => {}); // git may exit before reading, e.g. when it's missing
    child.stdin?.end(input ?? '');
  });
}

// One commit at a time, so two saves never race for git's index lock.
let gitQueue = Promise.resolve();
const NOTHING = /did not match any file|nothing to commit|no changes added/i;

// Commits changes to these paths (absolute; files or folders, present or deleted) in one
// commit with the profile as author. Resolves with { committed, commitError? }.
// what: the start of the message if committing fails ("Saved", "Deleted", "Uploaded").
export function commitPaths(profile, paths, message, what = 'Saved') {
  const run = async () => {
    const inside = await git(['rev-parse', '--is-inside-work-tree']);
    if (inside.missing) {
      return fs.existsSync(path.join(root(), '.git'))
        ? { committed: false, commitError: `${what}, but not committed: git isn't installed or isn't on the PATH of the account running Nova.` }
        : { committed: false };
    }
    if (!inside.ok || inside.out.trim() !== 'true') return { committed: false };
    const ignored = new Set((await git(['check-ignore', '-z', '--stdin'], {}, paths.join('\0'))).out.split('\0').filter(Boolean));
    const keep = paths.filter((p) => !ignored.has(p));
    if (!keep.length) return { committed: false };
    const list = keep.join('\0');
    // Use the repository's own committer if it has one; otherwise name Nova.
    const env = (await git(['config', 'user.email'])).ok ? {} : { GIT_COMMITTER_NAME: 'Nova', GIT_COMMITTER_EMAIL: 'nova@localhost' };
    const add = await git(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {}, list);
    const done = add.ok && await git(['commit', '-m', message, `--author=${profile} <${profile}@nova.local>`, '--pathspec-from-file=-', '--pathspec-file-nul'], env, list);
    if (done?.ok) return { committed: true };
    const failed = done || add;
    if (NOTHING.test(failed.err + failed.out)) return { committed: false }; // e.g. files git never tracked
    console.error(`git commit "${message}" failed:`, failed.err || failed.out);
    return { committed: false, commitError: `${what}, but the git commit failed: ${failed.err.trim().split('\n').pop() || 'git reported an error'}` };
  };
  const result = gitQueue.then(run, run);
  gitQueue = result.catch(() => {});
  return result;
}
