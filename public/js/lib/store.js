// Per-browser preferences in localStorage, under "nova.<key>" as JSON: the theme, the open view,
// picked model and effort, the avatar, expanded folders and so on. Storage can be blocked
// (private windows, some policies), so reads fall back to the default and writes are skipped.
export const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(`nova.${k}`)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`nova.${k}`, JSON.stringify(v)); } catch {} }
};
