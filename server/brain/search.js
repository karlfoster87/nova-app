// Search inside the brain's text, for the search palette (Ctrl+K). An in-memory SQLite FTS5
// index (built into node:sqlite, no dependency) holds every markdown, text and HTML file that
// isn't hidden from everyone, other profiles' notes folders included, so one index serves every
// profile; each result is checked with isHidden for the profile asking before it's shown. The
// index is built on the first search and brought up to date (by modification time and size)
// at most every few seconds after that, so files Claude writes are found without a watcher.
// It lives in memory only: a restart, or a new brain folder (which restarts Nova), starts afresh.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { requireView } from '../accounts/access.js';
import { root, walkFiles, isHidden, decode, extOf, EVERYONE } from './resolve.js';

const TEXT = new Set(['.md', '.markdown', '.mdx', '.txt', '.html', '.htm']);
const FILE_MAX = 1024 * 1024;   // bigger files are left out of the index
const FILES_MAX = 50000;
const FRESH = 15 * 1000;        // how long a sync is trusted before the next search checks the disk
const RESULTS = 15;

const db = new DatabaseSync(':memory:');
db.exec("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, name, body, tokenize = 'unicode61 remove_diacritics 2')");
const add = db.prepare('INSERT INTO docs (path, name, body) VALUES (?, ?, ?)');
const drop = db.prepare('DELETE FROM docs WHERE rowid = ?');
// The name counts eight times as much as the text; a snippet of about a dozen words around the match.
const find = db.prepare(`SELECT path, snippet(docs, 2, '', '', '…', 14) AS snippet FROM docs WHERE docs MATCH ?
  ORDER BY bm25(docs, 0, 8, 1) LIMIT 300`);

const files = new Map(); // rel -> { mtime, size, rowid }
let syncedAt = 0;

// HTML's words without its tags, scripts and styles, so markup doesn't match.
function htmlText(html) {
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'');
}

// Adds new and changed files and drops ones that went away. A file that can't be read or isn't
// UTF-8 text is left out.
function sync() {
  if (Date.now() - syncedAt < FRESH) return;
  const seen = new Set();
  db.exec('BEGIN');
  try {
    walkFiles(EVERYONE, root(), '', ({ abs, rel, st }) => {
      if (!TEXT.has(extOf(rel)) || st.size > FILE_MAX) return true;
      seen.add(rel);
      const had = files.get(rel);
      if (had && had.mtime === st.mtimeMs && had.size === st.size) return true;
      if (had) drop.run(had.rowid);
      let text = null;
      try { text = decode(fs.readFileSync(abs)); } catch {}
      if (text === null) { files.delete(rel); return true; }
      const body = ['.html', '.htm'].includes(extOf(rel)) ? htmlText(text) : text;
      const name = path.posix.basename(rel).replace(/\.[^.]+$/, '');
      const rowid = Number(add.run(rel, name, body).lastInsertRowid);
      files.set(rel, { mtime: st.mtimeMs, size: st.size, rowid });
      return seen.size < FILES_MAX;
    });
    for (const [rel, f] of files) if (!seen.has(rel)) { drop.run(f.rowid); files.delete(rel); }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  syncedAt = Date.now();
}

// Words typed into an FTS5 query: each one quoted (so nothing in it is query syntax) and
// matched as a prefix, all of them required.
export function ftsQuery(q) {
  return String(q || '').slice(0, 200).split(/\s+/)
    .map((w) => w.replace(/"/g, '')).filter((w) => /[\p{L}\p{N}]/u.test(w))
    .map((w) => `"${w}"*`).join(' ');
}

// Files whose text (or name) holds every word, best first, with a snippet around the match.
// Only paths this profile can see; other profiles' notes folders are never shown.
export function searchBrainText(profile, q) {
  requireView(profile, 'brain', 'read');
  const query = ftsQuery(q);
  if (!query) return [];
  sync();
  const out = [];
  for (const r of find.all(query)) {
    if (isHidden(r.path, profile)) continue;
    out.push({ path: r.path, name: path.posix.basename(r.path), snippet: r.snippet.replace(/\s+/g, ' ').trim() });
    if (out.length >= RESULTS) break;
  }
  return out;
}
