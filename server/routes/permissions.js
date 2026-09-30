// Remembered approvals and extra folders: each profile manages only its own. Open chats read
// both when their process starts, so a change restarts them as soon as they're quiet.
import { readJson } from '../http/respond.js';
import { requireAdmin } from '../accounts/profiles.js';
import { refreshRunners } from '../chat/runner.js';
import { listApprovals, forgetApproval, shareApproval, listFolders, addFolder, removeFolder } from '../chat/permissions.js';

export default function permissionRoutes(api) {
  api.get('/api/approvals', ({ profile }) => listApprovals(profile));
  api.delete('/api/approvals', async ({ req, profile }) => {
    const { tool, rule } = await readJson(req);
    forgetApproval(profile, tool, rule);
    refreshRunners(profile); // chats that already added the rule to their session drop it
    return listApprovals(profile);
  });
  // The shared settings file applies to every profile, so sharing is an admin's decision.
  api.post('/api/approvals/share', async ({ req, profile }) => {
    requireAdmin(profile, 'Only an admin can share a rule with every profile.');
    const { tool, rule } = await readJson(req);
    const shared = await shareApproval(profile, tool, rule);
    return { ...shared, approvals: listApprovals(profile) };
  });

  api.get('/api/folders', ({ profile }) => listFolders(profile));
  api.post('/api/folders', async ({ req, profile }) => {
    const dir = addFolder(profile, (await readJson(req)).path);
    refreshRunners(profile);
    return { path: dir, folders: listFolders(profile) };
  });
  api.delete('/api/folders', async ({ req, profile }) => {
    removeFolder(profile, (await readJson(req)).path);
    refreshRunners(profile);
    return listFolders(profile);
  });
}
