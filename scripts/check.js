// Syntax-checks every server, browser and script file, in subfolders too, and checks that
// every relative or site-absolute import points at a file that exists (a moved module fails
// here, not in the browser). Run before committing; a staged self-update runs the new
// version's copy of it.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);

// Static imports and import('...') with a literal path. /vendor/ is served from node_modules.
const IMPORT = /(?:^|\n)\s*import\s[^'"]*?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const VIEW_MODULE = /['"](\.\.\/views\/[a-z-]+\.js)['"]/g; // shell/views.js imports these by name
function missingImports(file) {
  const text = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''); // not examples in comments
  const specs = [...text.matchAll(IMPORT)].map((m) => m[1] || m[2]);
  if (file.endsWith(path.join('shell', 'views.js'))) specs.push(...[...text.matchAll(VIEW_MODULE)].map((m) => m[1]));
  return specs.filter((s) => (s.startsWith('.') || (s.startsWith('/') && !s.startsWith('/vendor/'))))
    .filter((s) => !existsSync(s.startsWith('/') ? path.join('public', s) : path.resolve(path.dirname(file), s)));
}

// Names imported with import { a, b as c } from './x.js' that x.js doesn't export.
const NAMED = /(?:^|\n)\s*import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g;
const exportsOf = (file) => {
  const text = readFileSync(file, 'utf8');
  const names = new Set([...text.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of m[1].split(',')) names.add(part.trim().split(/\s+as\s+/).pop());
  return names;
};
function missingNames(file) {
  const text = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return [...text.matchAll(NAMED)].flatMap(([, list, spec]) => {
    const target = path.resolve(path.dirname(file), spec);
    if (!existsSync(target)) return [];
    const have = exportsOf(target);
    return list.split(',').map((p) => p.trim().split(/\s+as\s+/)[0]).filter((n) => n && !have.has(n)).map((n) => `${n} from ${spec}`);
  });
}

let failed = false, count = 0;
for (const file of ['server', 'public', 'scripts'].flatMap(files)) {
  count++;
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (err) { failed = true; console.error(`${file}\n${err.stderr}`); }
  for (const spec of missingImports(file)) { failed = true; console.error(`${file}: imports ${spec}, which doesn't exist`); }
  for (const what of missingNames(file)) { failed = true; console.error(`${file}: imports ${what}, which doesn't export it`); }
}
if (failed) process.exit(1);
console.log(`All ${count} files pass the syntax check, and their imports exist.`);
