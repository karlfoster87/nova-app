// SQLite index: profiles, sign-ins, chats and their categories, approvals and folders, tasks,
// notes, attachments and profile pictures. Transcripts stay in Claude Code's own session files.
// Every statement lives in the q map below, grouped by area.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR, BRAIN } from './config.js';

export const db = new DatabaseSync(path.join(DATA_DIR, 'nova.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS profiles (
    name TEXT PRIMARY KEY, pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logins (
    token TEXT PRIMARY KEY, profile TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY, profile TEXT NOT NULL, title TEXT,
    model TEXT, effort TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chats_profile ON chats(profile, updated_at DESC);
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, profile TEXT NOT NULL, name TEXT NOT NULL,
    position INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS categories_profile ON categories(profile, position);
  CREATE TABLE IF NOT EXISTS approvals (
    profile TEXT NOT NULL, tool TEXT NOT NULL, rule TEXT NOT NULL, behavior TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (profile, tool, rule, behavior)
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, profile TEXT NOT NULL, parent_id TEXT, day TEXT, title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'waiting', position INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS tasks_day ON tasks(profile, parent_id, day);
  CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, profile TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', color TEXT NOT NULL,
    position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notes_profile ON notes(profile, position);
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY, profile TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, type TEXT NOT NULL,
    created_at INTEGER NOT NULL, chat_id TEXT
  );
  CREATE INDEX IF NOT EXISTS uploads_unsent ON uploads(chat_id, created_at);
  CREATE TABLE IF NOT EXISTS folders (
    profile TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (profile, path)
  );
  CREATE TABLE IF NOT EXISTS pictures (
    profile TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, updated_at INTEGER NOT NULL
  );
`);

// ---- Migrations ---------------------------------------------------------------
// Additive only: columns added after v0.1. Older databases gain them on start.
function addColumn(table, column, definition) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('chats', 'permission_mode', 'TEXT');
addColumn('chats', 'category_id', 'TEXT');   // null = uncategorised
addColumn('chats', 'brain', 'TEXT');
addColumn('categories', 'brain', 'TEXT');
addColumn('profiles', 'role', "TEXT NOT NULL DEFAULT 'user'");
addColumn('profiles', 'pin_hash', 'TEXT');
addColumn('profiles', 'access', 'TEXT');     // JSON { view: level }, null = defaults
addColumn('profiles', 'prefs', 'TEXT');      // JSON personal preferences, null = defaults
addColumn('notes', 'active', 'INTEGER NOT NULL DEFAULT 1'); // 0 = long-standing

// Rows from before chats were tied to a brain belong to whichever brain is active the
// first time this runs.
db.prepare('UPDATE chats SET brain = ? WHERE brain IS NULL').run(BRAIN);
db.prepare('UPDATE categories SET brain = ? WHERE brain IS NULL').run(BRAIN);
db.exec('CREATE INDEX IF NOT EXISTS chats_brain ON chats(profile, brain, updated_at DESC)');

// There must always be an admin. If none exists (a v0.1 database, or the last one was
// removed by hand), the oldest profile becomes admin.
if (!db.prepare("SELECT 1 FROM profiles WHERE role = 'admin'").get()) {
  db.exec("UPDATE profiles SET role = 'admin' WHERE name = (SELECT name FROM profiles ORDER BY created_at LIMIT 1)");
}

// ---- Statements -----------------------------------------------------------------

// Chats and categories are scoped to the active brain folder. These statements take the
// brain key as their last parameter, and scoped() supplies it, so callers never pass it
// and can't forget it. Rows for other brains stay in the table untouched.
const scoped = (sql) => {
  const stmt = db.prepare(sql);
  return { all: (...a) => stmt.all(...a, BRAIN), get: (...a) => stmt.get(...a, BRAIN), run: (...a) => stmt.run(...a, BRAIN) };
};

export const q = {
  // Profiles and sign-ins. Names are unique ignoring case.
  profile: db.prepare('SELECT * FROM profiles WHERE name = ? COLLATE NOCASE'),
  profiles: scoped(`SELECT p.name, p.role, p.pin_hash IS NOT NULL AS has_pin, p.created_at,
    (SELECT COUNT(*) FROM chats c WHERE c.profile = p.name AND c.brain = ?1) AS chat_count,
    (SELECT updated_at FROM pictures pic WHERE pic.profile = p.name) AS picture FROM profiles p ORDER BY p.created_at`),
  adminCount: db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE role = 'admin'"),
  addProfile: db.prepare('INSERT INTO profiles (name, pass_hash, created_at, role, pin_hash) VALUES (?, ?, ?, ?, ?)'),
  setPassword: db.prepare('UPDATE profiles SET pass_hash = ? WHERE name = ?'),
  setPin: db.prepare('UPDATE profiles SET pin_hash = ? WHERE name = ?'),
  setRole: db.prepare('UPDATE profiles SET role = ? WHERE name = ?'),
  setAccess: db.prepare('UPDATE profiles SET access = ? WHERE name = ?'),
  setPrefs: db.prepare('UPDATE profiles SET prefs = ? WHERE name = ?'),
  addLogin: db.prepare('INSERT INTO logins (token, profile, expires_at) VALUES (?, ?, ?)'),
  login: db.prepare('SELECT * FROM logins WHERE token = ? AND expires_at > ?'),
  dropLogin: db.prepare('DELETE FROM logins WHERE token = ?'),
  picture: db.prepare('SELECT type, data, updated_at FROM pictures WHERE profile = ?'),
  pictureStamp: db.prepare('SELECT updated_at FROM pictures WHERE profile = ?'),
  setPicture: db.prepare('INSERT OR REPLACE INTO pictures (profile, type, data, updated_at) VALUES (?, ?, ?, ?)'),
  deletePicture: db.prepare('DELETE FROM pictures WHERE profile = ?'),

  // Chats and categories, in the active brain.
  chat: scoped('SELECT * FROM chats WHERE id = ? AND brain = ?'),
  allChatIds: db.prepare('SELECT id FROM chats'), // every profile and brain: transcript move only
  chats: scoped('SELECT id, title, model, effort, permission_mode, category_id, updated_at FROM chats WHERE profile = ? AND brain = ? ORDER BY updated_at DESC LIMIT 500'),
  addChat: scoped('INSERT INTO chats (id, profile, title, model, effort, created_at, updated_at, category_id, brain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  touchChat: db.prepare('UPDATE chats SET updated_at = ?, model = ?, effort = ? WHERE id = ?'),
  setChatMode: db.prepare('UPDATE chats SET permission_mode = ? WHERE id = ? AND profile = ?'),
  setChatCategory: db.prepare('UPDATE chats SET category_id = ? WHERE id = ? AND profile = ?'),
  renameChat: db.prepare('UPDATE chats SET title = ? WHERE id = ? AND profile = ?'),
  deleteChat: db.prepare('DELETE FROM chats WHERE id = ? AND profile = ?'),
  categories: scoped('SELECT id, name, position FROM categories WHERE profile = ? AND brain = ? ORDER BY position, created_at'),
  category: scoped('SELECT * FROM categories WHERE id = ? AND brain = ?'),
  categoryByName: scoped('SELECT * FROM categories WHERE profile = ? AND name = ? COLLATE NOCASE AND brain = ?'),
  nextCategoryPosition: scoped('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM categories WHERE profile = ? AND brain = ?'),
  addCategory: scoped('INSERT INTO categories (id, profile, name, position, created_at, brain) VALUES (?, ?, ?, ?, ?, ?)'),
  renameCategory: db.prepare('UPDATE categories SET name = ? WHERE id = ? AND profile = ?'),
  setCategoryPosition: db.prepare('UPDATE categories SET position = ? WHERE id = ? AND profile = ?'),
  uncategorise: db.prepare('UPDATE chats SET category_id = NULL WHERE category_id = ? AND profile = ?'),
  deleteCategory: db.prepare('DELETE FROM categories WHERE id = ? AND profile = ?'),

  // Remembered approvals and extra folders: per profile, across brains. rule '' = the whole tool.
  approvals: db.prepare('SELECT tool, rule, behavior, created_at FROM approvals WHERE profile = ? ORDER BY created_at DESC'),
  approval: db.prepare("SELECT 1 FROM approvals WHERE profile = ? AND tool = ? AND rule = ? AND behavior = 'allow'"),
  addApproval: db.prepare("INSERT OR IGNORE INTO approvals (profile, tool, rule, behavior, created_at) VALUES (?, ?, ?, 'allow', ?)"),
  deleteApproval: db.prepare("DELETE FROM approvals WHERE profile = ? AND tool = ? AND rule = ? AND behavior = 'allow'"),
  folders: db.prepare('SELECT path, created_at FROM folders WHERE profile = ? ORDER BY created_at'),
  addFolder: db.prepare('INSERT OR IGNORE INTO folders (profile, path, created_at) VALUES (?, ?, ?)'),
  deleteFolder: db.prepare('DELETE FROM folders WHERE profile = ? AND path = ?'),

  // Files attached in the composer. chat_id is null until the message is sent.
  upload: db.prepare('SELECT * FROM uploads WHERE id = ?'),
  addUpload: db.prepare('INSERT INTO uploads (id, profile, name, size, type, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  sendUpload: db.prepare('UPDATE uploads SET chat_id = ? WHERE id = ? AND profile = ? AND chat_id IS NULL'),
  deleteUpload: db.prepare('DELETE FROM uploads WHERE id = ? AND profile = ?'),
  staleUploads: db.prepare('SELECT id, profile FROM uploads WHERE chat_id IS NULL AND created_at < ?'),

  // Tasks: only top-level tasks carry a day; children follow their parent. Per profile, across brains.
  task: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  // Top-level tasks from today on, unscheduled ones, and open ones from earlier days
  // (overdue), each with all its descendants. Finished tasks on past days are left out.
  tasksFrom: db.prepare(`WITH RECURSIVE tree AS (
      SELECT * FROM tasks WHERE profile = ?1 AND parent_id IS NULL
        AND (day IS NULL OR day >= ?2 OR state != 'complete')
      UNION ALL SELECT t.* FROM tasks t JOIN tree ON t.parent_id = tree.id)
    SELECT id, parent_id, day, title, note, state, position, created_at, updated_at, completed_at FROM tree`),
  // Unfinished bottom-level tasks under the day's top-level tasks: what's left to do that day.
  tasksLeft: db.prepare(`WITH RECURSIVE tree(id, state) AS (
      SELECT id, state FROM tasks WHERE profile = ?1 AND parent_id IS NULL AND day = ?2
      UNION ALL SELECT t.id, t.state FROM tasks t JOIN tree ON t.parent_id = tree.id)
    SELECT COUNT(*) AS n FROM tree WHERE state != 'complete' AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = tree.id)`),
  taskSiblings: db.prepare('SELECT id FROM tasks WHERE profile = ? AND parent_id IS ? AND day IS ? ORDER BY position, created_at'),
  nextTaskPosition: db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM tasks WHERE profile = ? AND parent_id IS ? AND day IS ?'),
  addTask: db.prepare('INSERT INTO tasks (id, profile, parent_id, day, title, note, state, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  updateTask: db.prepare('UPDATE tasks SET title = ?, note = ?, state = ?, completed_at = ?, updated_at = ? WHERE id = ? AND profile = ?'),
  placeTask: db.prepare('UPDATE tasks SET parent_id = ?, day = ?, position = ?, updated_at = ? WHERE id = ? AND profile = ?'),
  setTaskPosition: db.prepare('UPDATE tasks SET position = ? WHERE id = ? AND profile = ?'),
  taskChildStates: db.prepare('SELECT state FROM tasks WHERE parent_id = ? AND profile = ?'),
  deleteTaskTree: db.prepare(`WITH RECURSIVE sub(id) AS (SELECT ?1 UNION ALL SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id)
    DELETE FROM tasks WHERE profile = ?2 AND id IN (SELECT id FROM sub)`),

  // Notes: a manual order in position, lowest first.
  notes: db.prepare('SELECT id, text, color, active, position, created_at, updated_at FROM notes WHERE profile = ? ORDER BY position, created_at'),
  activeNotes: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE profile = ? AND active = 1'),
  note: db.prepare('SELECT * FROM notes WHERE id = ?'),
  firstNotePosition: db.prepare('SELECT COALESCE(MIN(position), 1) - 1 AS n FROM notes WHERE profile = ?'),
  addNote: db.prepare('INSERT INTO notes (id, profile, text, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updateNote: db.prepare('UPDATE notes SET text = ?, color = ?, active = ?, updated_at = ? WHERE id = ? AND profile = ?'),
  setNotePosition: db.prepare('UPDATE notes SET position = ? WHERE id = ? AND profile = ?'),
  deleteNote: db.prepare('DELETE FROM notes WHERE id = ? AND profile = ?')
};

// Every table holding a profile's rows, so renaming or removing a profile covers them all in
// one place. A new per-profile table goes in this list. Callers run these in a transaction.
const PROFILE_TABLES = ['logins', 'chats', 'categories', 'approvals', 'folders', 'tasks', 'notes', 'uploads', 'pictures'];
const renames = PROFILE_TABLES.map((t) => db.prepare(`UPDATE ${t} SET profile = ? WHERE profile = ?`));
const deletes = PROFILE_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE profile = ?`));
const renameRow = db.prepare('UPDATE profiles SET name = ? WHERE name = ?');
const deleteRow = db.prepare('DELETE FROM profiles WHERE name = ?');
export const renameProfileRows = (oldName, newName) => { renameRow.run(newName, oldName); for (const s of renames) s.run(newName, oldName); };
export const deleteProfileRows = (name) => { for (const s of deletes) s.run(name); deleteRow.run(name); };

// Runs fn inside one transaction, rolling back if it throws.
export function transaction(fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (err) { db.exec('ROLLBACK'); throw err; }
}

// A manual order: puts id before beforeId among ids (or last when beforeId is missing or
// unknown), then saves every position from 0 with setPosition(position, id), so positions
// stay small and gap-free. Run it inside a transaction.
export function reorder(ids, id, beforeId, setPosition) {
  const order = ids.filter((x) => x !== id);
  const at = beforeId ? order.indexOf(String(beforeId)) : -1;
  order.splice(at < 0 ? order.length : at, 0, id);
  order.forEach((x, i) => setPosition(i, x));
  return order;
}
