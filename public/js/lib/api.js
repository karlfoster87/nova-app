// The page's one way to call Nova's JSON API. A 401 means the session ended, so it goes to
// the sign-in page, except on /api/switch, where a 401 answers a wrong PIN or password.
// Errors carry the server's message, which is written to be shown, and the HTTP status.

// Names this tab to the server (X-Nova-Tab), so a view can skip the echo of its own changes.
// randomUUID needs a secure context, which plain http on a LAN address isn't.
export const TAB_ID = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Nova-Tab': TAB_ID, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 && url !== '/api/switch') { location.href = '/login'; throw new Error('Signed out.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status}). Try again.`);
    err.status = res.status;
    throw err;
  }
  return data;
}
