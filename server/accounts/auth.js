// Per-profile password login with scrypt hashes and an HttpOnly session cookie.
// In remote mode this sits behind Cloudflare Access; it is the second layer, not the only one.
// A PIN only ever works for switching from a session that is already signed in.
import crypto from 'node:crypto';
import { q } from './db.js';
import { config } from './config.js';

const COOKIE = 'nova_session';
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const ttlMs = () => config.security.sessionDays * 24 * 3600 * 1000;

// Passwords and PINs share one scrypt format.
export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export const hashPassword = hashSecret;

export function verifySecret(secret, stored) {
  if (!stored) return false;
  const [, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(secret, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

// In-memory throttle, shared by password sign-in and PIN switching, per target profile.
const failures = new Map();
const windowMs = () => config.security.lockoutMinutes * 60 * 1000;
// Keyed ignoring case, so typing a name differently doesn't reset the count.
function throttled(name) {
  const f = failures.get(name.toLowerCase());
  return f && f.count >= config.security.maxAttempts && Date.now() - f.first < windowMs();
}
function recordFailure(name) {
  const key = name.toLowerCase();
  const f = failures.get(key);
  if (!f || Date.now() - f.first > windowMs()) failures.set(key, { count: 1, first: Date.now() });
  else f.count++;
}
const lockedMessage = () => `Too many attempts. Try again in ${config.security.lockoutMinutes} minutes.`;

// Sessions always carry the stored spelling of the name, however it was typed.
function startSession(name) {
  failures.delete(name.toLowerCase());
  const token = crypto.randomBytes(32).toString('base64url');
  q.addLogin.run(token, name, Date.now() + ttlMs());
  return { token };
}

export function login(name, pw) {
  if (throttled(name)) return { error: lockedMessage() };
  const row = q.profile.get(name);
  if (!row || !verifySecret(pw, row.pass_hash)) {
    recordFailure(name);
    return { error: 'Profile name or password is incorrect.' };
  }
  return startSession(row.name);
}

// Switch from a signed-in session to another profile using its PIN, or its password
// when it has no PIN. The caller drops the old session.
export function switchTo(name, { pin, password }) {
  if (throttled(name)) return { error: lockedMessage() };
  const row = q.profile.get(name);
  if (!row) return { error: 'That profile doesn\'t exist.' };
  const ok = row.pin_hash && pin ? verifySecret(String(pin), row.pin_hash)
    : password ? verifySecret(String(password), row.pass_hash) : false;
  if (!ok) {
    recordFailure(name);
    return { error: row.pin_hash && pin ? 'That PIN is incorrect.' : 'That password is incorrect.' };
  }
  return startSession(row.name);
}

export function cookieHeader(token, clear = false) {
  const parts = [`${COOKIE}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${clear ? 0 : ttlMs() / 1000}`];
  if (config.server.mode === 'remote') parts.push('Secure');
  return parts.join('; ');
}

export function tokenFrom(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

export function profileFrom(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const row = q.login.get(token, Date.now());
  return row ? row.profile : null;
}

export function logout(req) {
  const token = tokenFrom(req);
  if (token) q.dropLogin.run(token);
}
