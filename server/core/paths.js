// Path comparison shared by the folder allow-list and the brain viewer. Windows and macOS
// paths ignore case, so compare them folded.
import fs from 'node:fs';
import path from 'node:path';

export const CASELESS = process.platform === 'win32' || process.platform === 'darwin';
export const fold = (p) => (CASELESS ? p.toLowerCase() : p);

// True when child is parent or inside it. Paths on different drives are never inside.
export function within(child, parent) {
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Forward-slash relative path from root, for the browser and for matching rules.
export const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

// Renames a file or folder. Case-insensitive file systems can refuse a rename that only
// changes case, so those go through a temporary name.
export function renamePath(from, to) {
  if (fold(from) !== fold(to)) return fs.renameSync(from, to);
  const temp = `${from}.renaming-${Date.now()}`;
  fs.renameSync(from, temp);
  fs.renameSync(temp, to);
}
