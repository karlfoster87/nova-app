// Web Push, written by hand with node:crypto so Nova needs no push library or vendor account.
// A browser that subscribes gives Nova an endpoint on its own push service (Microsoft's for
// Edge, Apple's for iOS, Google's for Chrome) and two keys. Nova encrypts each message for that
// browser alone (RFC 8291, aes128gcm), signs a short-lived token with its own key pair (VAPID,
// RFC 8292) and posts it to the endpoint (RFC 8030); the push service only ever sees ciphertext.
// This file is pure: no database or config, so the smoke test can check it against the RFC's
// own test vector.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// A P-256 key pair for VAPID. The public key goes to browsers as applicationServerKey (65 raw
// bytes, uncompressed); the private key stays in the data folder as a JWK.
export function generateVapidKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { jwk: privateKey.export({ format: 'jwk' }) };
}
export const vapidPublicKey = (jwk) => b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));

// Checks a subscription's keys have the right shape before anything is stored or sent.
export function validKeys(p256dh, auth) {
  try {
    const pub = fromB64u(p256dh), secret = fromB64u(auth);
    if (pub.length !== 65 || pub[0] !== 4 || secret.length !== 16) return false;
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(pub); // throws if the point isn't on the curve
    return true;
  } catch { return false; }
}

// RFC 8291 section 3: one record, so the whole payload must fit in it (Nova's are tiny).
// test: { salt, asPrivate } fixes the random parts, only for the RFC's test vector.
export function encrypt(payload, { p256dh, auth }, test = {}) {
  const uaPublic = fromB64u(p256dh);
  const ecdh = crypto.createECDH('prime256v1');
  if (test.asPrivate) ecdh.setPrivateKey(fromB64u(test.asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = test.salt ? fromB64u(test.salt) : crypto.randomBytes(16);
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, fromB64u(auth), keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16); // record size
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// The VAPID token: valid for 12 hours, for the push service's origin only.
function vapidAuth(endpoint, jwk, subject) {
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => b64u(JSON.stringify(o));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub: subject })}`;
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapidPublicKey(jwk)}`;
}

// Sends one message. Resolves to the push service's status: 201 means accepted; 404 and 410
// mean the subscription is gone for good.
export async function sendPush(sub, payload, { jwk, subject, ttl = 43200, urgency = 'normal' }) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: vapidAuth(sub.endpoint, jwk, subject), 'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency },
    body: encrypt(JSON.stringify(payload), sub),
    signal: AbortSignal.timeout(10000)
  });
  await res.arrayBuffer().catch(() => {});
  return res.status;
}
