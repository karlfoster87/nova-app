// Profiles: everyone can list them (to switch) and edit themselves; admins manage all.
// profiles.js checks who may change what.
import { UserError } from '../core/errors.js';
import { readJson, readRaw, send } from '../http/respond.js';
import {
  listProfiles, createProfile, updateProfile, deleteProfile, requireAdmin, setPicture, removePicture, readPicture
} from '../accounts/profiles.js';

const PROFILE = /^\/api\/profiles\/([A-Za-z0-9-]{2,32})$/;
const PICTURE = /^\/api\/profiles\/([A-Za-z0-9-]{2,32})\/picture$/;

export default function profileRoutes(api) {
  api.get('/api/profiles', ({ profile }) => listProfiles(profile));
  api.post('/api/profiles', async ({ req, profile }) => {
    requireAdmin(profile, 'Only an admin can add profiles.');
    return { ok: true, name: createProfile(await readJson(req)) };
  });
  api.patch(PROFILE, async ({ req, profile, params: [name] }) => ({ ok: true, name: updateProfile(profile, name, await readJson(req)) }));
  api.delete(PROFILE, ({ profile, params: [name] }) => { deleteProfile(profile, name); return { ok: true }; });

  // Pictures: every signed-in profile sees them (the switcher shows everyone), and only the
  // profile itself or an admin changes one. URLs carry ?v=updated_at, so they cache long.
  api.get(PICTURE, ({ res, params: [name] }) => {
    const pic = readPicture(name);
    if (!pic) throw new UserError('This profile has no picture.', 404);
    send(res, 200, Buffer.from(pic.data), { 'Content-Type': pic.type, 'Cache-Control': 'private, max-age=31536000, immutable' });
  });
  api.post(PICTURE, async ({ req, profile, params: [name] }) => ({ picture: setPicture(profile, name, await readRaw(req, 512 * 1024 + 1)) }));
  api.delete(PICTURE, ({ profile, params: [name] }) => { removePicture(profile, name); return { picture: null }; });
}
