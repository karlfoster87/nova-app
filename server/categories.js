// Chat categories. Each profile has its own; a chat belongs to at most one, and
// category_id = null means uncategorised. Every lookup checks the profile.
import crypto from 'node:crypto';
import { q, transaction } from './db.js';
import { UserError } from './errors.js';

export function ownedCategory(profile, id) {
  const row = id ? q.category.get(id) : null;
  return row && row.profile === profile ? row : null;
}

function cleanName(profile, name, exceptId = null) {
  name = String(name || '').replace(/\s+/g, ' ').trim();
  if (!name) throw new UserError('Give the category a name.');
  if (name.length > 60) throw new UserError('Keep category names to 60 characters or fewer.');
  const clash = q.categoryByName.get(profile, name);
  if (clash && clash.id !== exceptId) throw new UserError(`You already have a category called "${clash.name}".`, 409);
  return name;
}

export function listCategories(profile) { return q.categories.all(profile); }

export function createCategory(profile, name) {
  name = cleanName(profile, name);
  const id = crypto.randomUUID();
  q.addCategory.run(id, profile, name, q.nextCategoryPosition.get(profile).n, Date.now());
  return { id, name };
}

export function renameCategory(profile, id, name) {
  if (!ownedCategory(profile, id)) throw new UserError('Category not found.', 404);
  name = cleanName(profile, name, id);
  q.renameCategory.run(name, id, profile);
  return { id, name };
}

// Moves a category before beforeId (another of the profile's categories), or to the end.
// The profile's categories in this brain are renumbered from 0, so the order is always clean.
export function moveCategory(profile, id, { beforeId = null } = {}) {
  if (!ownedCategory(profile, id)) throw new UserError('Category not found.', 404);
  if (beforeId != null && (beforeId === id || !ownedCategory(profile, String(beforeId)))) throw new UserError('Category not found.', 404);
  transaction(() => {
    const order = listCategories(profile).map((c) => c.id).filter((c) => c !== id);
    const at = beforeId ? order.indexOf(String(beforeId)) : -1;
    order.splice(at < 0 ? order.length : at, 0, id);
    order.forEach((c, i) => q.setCategoryPosition.run(i, c, profile));
  });
  return listCategories(profile);
}

// Deleting a category keeps its chats; they become uncategorised.
export function deleteCategory(profile, id) {
  if (!ownedCategory(profile, id)) throw new UserError('Category not found.', 404);
  transaction(() => {
    q.uncategorise.run(id, profile);
    q.deleteCategory.run(id, profile);
  });
}

// Validates a category a chat is being filed under; null means uncategorised.
export function categoryIdFor(profile, id) {
  if (id == null || id === '') return null;
  if (!ownedCategory(profile, id)) throw new UserError('Category not found.', 404);
  return id;
}
