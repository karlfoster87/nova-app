// A small reader for GitHub's tarballs, so Nova's own updates need no tar dependency: ustar
// entries, with pax ('x') and GNU ('L') long names. The first path segment (the repo-commit
// folder) is dropped. Links aren't expected and are skipped; a path leading out of dest is refused.
import fs from 'node:fs';
import path from 'node:path';

export function untar(buf, dest) {
  const root = path.resolve(dest);
  const text = (a, b) => buf.toString('utf8', a, b).replace(/\0[\s\S]*$/, '');
  let off = 0, longName = null;
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) break;
    const name = text(off, off + 100), prefix = text(off + 345, off + 500);
    const mode = parseInt(text(off + 100, off + 108).trim() || '644', 8);
    const size = parseInt(text(off + 124, off + 136).trim() || '0', 8);
    const type = String.fromCharCode(buf[off + 156]);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;
    if (type === 'x') { longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? longName; continue; }
    if (type === 'L') { longName = body.toString('utf8').replace(/\0[\s\S]*$/, ''); continue; }
    const full = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    const rel = full.split('/').slice(1).join('/');
    if (!rel) continue;
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) throw new Error(`The download has an unsafe path (${full}). Nothing was changed.`);
    if (type === '5') fs.mkdirSync(target, { recursive: true });
    else if (type === '0' || type === '\0' || type === '7') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, { mode: mode & 0o777 });
    }
  }
}
