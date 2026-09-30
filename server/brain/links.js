// Obsidian-style [[links]] in brain notes: the browser sends the targets a note links to, and
// this says which file each one means, the way Obsidian decides.
import path from 'node:path';
import { requireView } from '../accounts/access.js';
import { fold } from '../core/paths.js';
import { root, walkFiles } from './resolve.js';

// Every file this profile can see, as paths from the root, cached briefly per profile so a
// page full of links costs one walk. Same visibility rules as the tree.
const INDEX_TTL = 30 * 1000, INDEX_MAX = 100000;
const indexes = new Map(); // profile -> { at, files }
function brainIndex(profile) {
  const hit = indexes.get(profile);
  if (hit && Date.now() - hit.at < INDEX_TTL) return hit.files;
  const files = [];
  walkFiles(profile, root(), '', ({ rel }) => { files.push(rel); return files.length < INDEX_MAX; });
  indexes.set(profile, { at: Date.now(), files });
  return files;
}

// File names changed (a delete or an upload): links must look again.
export const clearLinkIndex = () => indexes.clear();

// Finds what [[target]] points at: by file name anywhere in the brain (".md" implied), or by a
// path when the target has a folder in it. With several matches, one in the linking note's own
// folder wins, then the shortest path.
// names: the targets as written, "#heading" and all. Returns { name: path | null }.
export function resolveLinks(profile, from, names) {
  requireView(profile, 'brain', 'read');
  names = [].concat(names || []).map(String).filter((n) => n.length <= 300).slice(0, 300);
  const files = brainIndex(profile);
  const byBase = new Map();
  for (const f of files) {
    const base = fold(f.slice(f.lastIndexOf('/') + 1));
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(f);
  }
  const fromDir = String(from || '').includes('/') ? String(from).slice(0, String(from).lastIndexOf('/')) : '';
  const depth = (f) => f.split('/').length;
  const pick = (list) => list.find((f) => f.slice(0, f.lastIndexOf('/') + 1) === (fromDir ? `${fromDir}/` : ''))
    || [...list].sort((a, b) => depth(a) - depth(b) || a.length - b.length)[0];

  const out = {};
  for (const name of names) {
    const target = name.split('#')[0].trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!target) { out[name] = from ? String(from) : null; continue; } // [[#Heading]]: this note
    const candidates = /\.md$/i.test(target) ? [target] : [`${target}.md`, target];
    let found = null;
    for (const cand of candidates) {
      let list = byBase.get(fold(cand.slice(cand.lastIndexOf('/') + 1))) || [];
      if (cand.includes('/')) {
        const want = fold(cand), near = fold(path.posix.normalize(fromDir ? `${fromDir}/${cand}` : cand));
        list = list.filter((f) => { const ff = fold(f); return ff === want || ff === near || ff.endsWith(`/${want}`); });
      }
      if (list.length) { found = pick(list); break; }
    }
    out[name] = found;
  }
  return out;
}
