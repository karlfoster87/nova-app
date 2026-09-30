// A small route table, so each area of the API lists its routes in one file (server/routes/).
// A route is a method, a path and a handler. The path is an exact string, or a RegExp whose
// capture groups arrive as params. The handler gets { req, res, url, profile, params } and
// returns what to send: a value goes out as JSON with status 200, and undefined means the
// handler sent the response itself (another status, a file, a stream).
import { send } from './respond.js';

export function createRouter() {
  const routes = [];
  const add = (method) => (path, handler) => { routes.push({ method, path, handler }); };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),

    // Runs the first route that matches. Returns false when none does.
    async handle(ctx) {
      const { req, res, url } = ctx;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = typeof r.path === 'string' ? (r.path === url.pathname ? [] : null) : r.path.exec(url.pathname);
        if (!m) continue;
        const out = await r.handler({ ...ctx, params: m.slice(1) });
        if (out !== undefined && !res.headersSent) send(res, 200, out);
        return true;
      }
      return false;
    }
  };
}
