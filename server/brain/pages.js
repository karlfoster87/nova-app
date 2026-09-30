// Rendered HTML pages in the brain viewer. An HTML file from the brain shows as a page in the
// viewer's frame, with the stylesheets and images it refers to. The route is path-shaped
// (/api/brain/page/<token>/<path>) so the page's relative links resolve to its neighbours
// with no rewriting. The page may have been written by anyone, so the CSP sandbox gives it an
// opaque origin (it can't read Nova's cookies or call its API) and no scripts run. Styles,
// images and fonts may come from the brain or the web, so reports that use a web font or a
// CDN stylesheet still look right.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../core/config.js';
import { UserError } from '../core/errors.js';
import { requireView } from '../accounts/access.js';
import { resolve, decode, extOf, HTML, IMAGES } from './resolve.js';

const PAGE_CSP = "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; " +
  "style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' data: https:; " +
  "media-src 'self' https:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const PAGE_PARTS = { '.css': 'text/css', ...IMAGES };

// With an opaque origin the page's own requests (its stylesheet, images, a link to the next
// page) carry no session cookie, which is SameSite=Strict. So readFile hands out a token that
// stands in for the profile, and it goes in the page's path where relative URLs keep it.
// It only reaches this route, which still checks the profile's access on every request.
// Tokens live in memory: a restart or 12 hours means opening the file again.
const PAGE_TTL = 12 * 60 * 60 * 1000;
const pageTokens = new Map(); // token -> { profile, expires }

export function pageToken(profile) {
  const now = Date.now();
  for (const [t, v] of pageTokens) if (v.expires < now) pageTokens.delete(t);
  for (const [t, v] of pageTokens) if (v.profile === profile && v.expires - now > PAGE_TTL / 2) return t;
  const token = crypto.randomBytes(24).toString('hex');
  pageTokens.set(token, { profile, expires: now + PAGE_TTL });
  return token;
}

export function pageProfile(token) {
  const v = pageTokens.get(token);
  if (!v || v.expires < Date.now()) throw new UserError('This page has expired. Open it again from the brain list.', 401);
  return v.profile;
}

// The page, or one of its stylesheets or images, for the profile the token names.
export function page(profile, input) {
  requireView(profile, 'brain', 'read');
  const { abs } = resolve(profile, input);
  const st = fs.statSync(abs);
  const ext = extOf(abs);
  if (!st.isFile() || (!HTML.has(ext) && !PAGE_PARTS[ext])) {
    throw new UserError('Only HTML pages, and the stylesheets and images they use, show here. Open other files from the brain list.', 415);
  }
  if (!IMAGES[ext] && st.size > config.brain.maxViewKB * 1024) throw new UserError('That file is too large to show here. Download it instead.', 413);
  const buf = fs.readFileSync(abs);
  // Brain files are UTF-8, but a page that isn't valid UTF-8 keeps its own <meta charset>.
  const text = !IMAGES[ext] && decode(buf) !== null;
  const type = HTML.has(ext) ? 'text/html' : PAGE_PARTS[ext];
  return {
    headers: { 'Content-Type': text ? `${type}; charset=utf-8` : type, 'Content-Length': buf.length, 'Cache-Control': 'no-store',
      'Content-Security-Policy': PAGE_CSP },
    write: async (res) => res.end(buf)
  };
}
