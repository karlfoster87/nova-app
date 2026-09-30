// Tracks open WebSocket connections per profile. Chat events go to every tab
// logged into that profile (desktop and phone stay in sync); nothing crosses profiles.
const sockets = new Map(); // profile -> Set<WebSocket>

export const hub = {
  add(profile, ws) {
    if (!sockets.has(profile)) sockets.set(profile, new Set());
    sockets.get(profile).add(ws);
    ws.on('close', () => sockets.get(profile)?.delete(ws));
  },
  toProfile(profile, payload) {
    const data = JSON.stringify(payload);
    for (const ws of sockets.get(profile) || []) if (ws.readyState === 1) ws.send(data);
  },
  // Tell every tab of a profile to reload, then drop them. Used when a profile is
  // renamed or removed, because each socket is bound to the name it signed in with.
  disconnect(profile, payload) {
    this.toProfile(profile, payload);
    for (const ws of sockets.get(profile) || []) ws.close(4001, 'Profile changed');
    sockets.delete(profile);
  },
  toAll(payload) {
    const data = JSON.stringify(payload);
    for (const set of sockets.values()) for (const ws of set) if (ws.readyState === 1) ws.send(data);
  }
};
