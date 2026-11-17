// Fetches a calendar feed from an address a profile gave. That makes Nova call a URL chosen by
// someone else, so it is careful about where: https only, and no loopback, private, link-local or
// other internal addresses, checked on the address actually connected to (the DNS answer, through
// a lookup hook, so a name can't point somewhere else between the check and the connection) and
// again after every redirect. Admins may also use http and addresses on the local network, for a
// self-hosted calendar at home. Answers are capped in size and time.
//
// Feed addresses often carry a secret token, so they never appear in errors or logs; messages
// name the host at most.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { config, VERSION } from '../core/config.js';
import { UserError } from '../core/errors.js';

const MAX_REDIRECTS = 5;

// True for addresses a profile's feed may not reach: anything that isn't the public internet.
export function internalAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return internalAddress(mapped[1]);
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('2001:db8');
}

// webcal:// is how calendar apps advertise a feed; it means https.
export function normaliseUrl(value, { admin = false } = {}) {
  let s = String(value || '').trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:/i, 'https:');
  let url;
  try { url = new URL(s); } catch { throw new UserError('That doesn\'t look like a web address. Paste the calendar\'s ICS or iCal address, starting with https://.'); }
  if (s.length > 2000) throw new UserError('That address is too long.');
  if (url.protocol !== 'https:' && !(admin && url.protocol === 'http:')) {
    throw new UserError(admin ? 'Use an address starting with https:// (or http:// for a calendar on your own network).' : 'Use an address starting with https://.');
  }
  return url;
}

// What the browser may see of an address: the host and the end of the path, never the secret.
export function addressHint(value) {
  try {
    const url = new URL(value);
    const last = url.pathname.split('/').filter(Boolean).pop() || '';
    return { host: url.host, hint: `${url.protocol}//${url.host}/…${last && last.length <= 24 ? `/${last}` : ''}` };
  } catch { return { host: '', hint: '' }; }
}

function guardedLookup(allowInternal) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
      if (!allowInternal && list.some((a) => internalAddress(a.address))) {
        const e = new Error('internal'); e.code = 'NOVA_INTERNAL'; return callback(e);
      }
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

function plainError(err, host) {
  if (err instanceof UserError) return err;
  if (err?.code === 'NOVA_INTERNAL') return new UserError(`${host} is on a private or local network, which only an admin's calendars may use.`);
  if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') return new UserError(`Couldn't find ${host}. Check the address.`);
  if (err?.code === 'ECONNREFUSED') return new UserError(`${host} refused the connection.`);
  if (err?.code === 'NOVA_TIMEOUT') return new UserError(`${host} took too long to answer.`);
  if (/certificate|SSL|TLS/i.test(err?.code || '') || /certificate/i.test(err?.message || '')) return new UserError(`${host} has a certificate problem, so Nova won't trust it.`);
  return new UserError(`Couldn't reach ${host}.`);
}

/**
 * Gets a feed. Resolves { status: 200, text, etag, modified } or { status: 304 }.
 * Throws a UserError that is safe to show (and store) when it can't.
 */
export async function fetchFeed(address, { admin = false, etag = null, modified = null } = {}) {
  let url = normaliseUrl(address, { admin });
  const maxBytes = (config.calendar?.maxMB || 10) * 1048576;
  const timeout = (config.calendar?.timeoutSec || 20) * 1000;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!admin && net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && internalAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
      throw plainError({ code: 'NOVA_INTERNAL' }, url.host);
    }
    const res = await new Promise((resolve, reject) => {
      const headers = { 'User-Agent': `Nova/${VERSION} (calendar)`, Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5', 'Accept-Encoding': 'gzip, deflate' };
      if (hop === 0 && etag) headers['If-None-Match'] = etag;
      if (hop === 0 && modified) headers['If-Modified-Since'] = modified;
      const auth = url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : undefined;
      const req = (url.protocol === 'https:' ? https : http).request(url, { method: 'GET', headers, auth, lookup: guardedLookup(admin) }, resolve);
      req.setTimeout(timeout, () => { const e = new Error('timeout'); e.code = 'NOVA_TIMEOUT'; req.destroy(e); });
      req.on('error', reject);
      req.end();
    }).catch((err) => { throw plainError(err, url.host); });

    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      let next;
      try { next = new URL(res.headers.location, url); } catch { throw new UserError(`${url.host} sent Nova to an address it can't use.`); }
      if (url.protocol === 'https:' && next.protocol === 'http:' && !admin) throw new UserError(`${url.host} sent Nova to an address without https.`);
      url = normaliseUrl(next.href, { admin });
      continue;
    }
    if (res.statusCode === 304) { res.resume(); return { status: 304 }; }
    if (res.statusCode !== 200) {
      res.resume();
      throw new UserError(res.statusCode === 401 || res.statusCode === 403 ? `${url.host} refused access (${res.statusCode}). The address may have been reset; copy it again from the calendar.`
        : res.statusCode === 404 ? `${url.host} has no calendar at that address (404).` : `${url.host} answered with an error (${res.statusCode}).`);
    }
    const declared = Number(res.headers['content-length']);
    if (declared > maxBytes) { res.resume(); throw new UserError(`That calendar is larger than ${config.calendar?.maxMB || 10} MB.`); }
    const enc = String(res.headers['content-encoding'] || '').toLowerCase();
    const body = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
    const chunks = [];
    let size = 0;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { body.destroy(); reject(new UserError(`${url.host} took too long to send the calendar.`)); }, timeout * 2);
      body.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { clearTimeout(timer); body.destroy(); res.destroy(); reject(new UserError(`That calendar is larger than ${config.calendar?.maxMB || 10} MB.`)); }
        else chunks.push(c);
      });
      body.on('end', () => { clearTimeout(timer); resolve(); });
      body.on('error', () => { clearTimeout(timer); reject(new UserError(`${url.host} sent a calendar Nova couldn't read.`)); });
    });
    return { status: 200, text: Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''), etag: res.headers.etag || null, modified: res.headers['last-modified'] || null };
  }
  throw new UserError(`${url.host} redirected too many times.`);
}
