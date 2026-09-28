// Path comparison shared by the folder allow-list and the brain viewer. Windows and macOS
// paths ignore case, so compare them folded.
import path from 'node:path';

export const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);

// True when child is parent or inside it. Paths on different drives are never inside.
export function within(child, parent) {
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Forward-slash relative path from root, for the browser and for matching rules.
export const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
