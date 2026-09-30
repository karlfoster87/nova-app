// HTTP plumbing shared by every route: the security headers, JSON and streamed responses,
// reading request bodies, and the same-origin rule.
import { UserError } from '../core/errors.js';

// On every response. The CSP is deliberately strict: no inline scripts, and no other origin
// except Google Fonts. Loosening it is a security decision, not a convenience.
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

// A string or Buffer goes as it is; anything else as JSON.
export function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...securityHeaders,
    'Content-Type': isJson ? 'application/json' : headers['Content-Type'] || 'text/plain', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

// A streamed body as the brain and attachment functions return it: { status?, headers, write(res) }.
// A client can go away mid-stream (a cancelled download, a video player seeking); `what`
// names the download in the log, and leaving it out keeps such stops quiet.
export async function sendStream(res, out, what = null) {
  res.writeHead(out.status || 200, { ...securityHeaders, ...out.headers });
  try { await out.write(res); } catch (err) {
    if (what) console.error(`${what} stopped:`, err.message);
    res.destroy();
  }
}

// Refusing on Content-Length before reading leaves the body unread, which Node discards while
// keeping the connection alive. Stopping partway through a read destroys the socket, and the
// client's next request on it fails, so the in-loop checks only catch bodies with no length.
const tooLong = (req, max) => Number(req.headers['content-length']) > max;

export async function readJson(req, max = 1e6) {
  const tooMuch = () => new UserError('That\'s too much to send in one request.', 413);
  if (tooLong(req, max)) throw tooMuch();
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > max) throw tooMuch(); }
  return raw ? JSON.parse(raw) : {};
}

export async function readRaw(req, max) {
  if (tooLong(req, max)) throw new UserError('That file is too big.', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new UserError('That file is too big.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Rejects cross-site requests that could ride on the session cookie. A request with no
// Origin header (same-origin GETs, scripts) passes; the cookie is SameSite=Strict anyway.
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
