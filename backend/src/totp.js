// RFC 4226 (HOTP) / RFC 6238 (TOTP) implemented with node:crypto — no external
// dependency. Used for opt-in two-factor auth. Compatible with Google
// Authenticator, 1Password, Authy, etc. (SHA1, 6 digits, 30s period).

import crypto from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Generate a base32-encoded secret (default 20 bytes / 160 bits).
export function generateSecret(byteLen = 20) {
  const bytes = crypto.randomBytes(byteLen);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(secret) {
  const clean = String(secret || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of clean) bits += BASE32.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

export function totp(secret, atMs = Date.now(), stepSec = 30) {
  return hotp(base32Decode(secret), Math.floor(atMs / 1000 / stepSec));
}

// Verify a 6-digit token, allowing ±`window` steps for clock skew.
export function verifyTotp(secret, token, atMs = Date.now(), window = 1) {
  if (!secret || !/^\d{6}$/.test(String(token || ''))) return false;
  const secretBuf = base32Decode(secret);
  const counter = Math.floor(atMs / 1000 / 30);
  const provided = Buffer.from(String(token));
  for (let w = -window; w <= window; w += 1) {
    const candidate = Buffer.from(hotp(secretBuf, counter + w));
    if (candidate.length === provided.length && crypto.timingSafeEqual(candidate, provided)) return true;
  }
  return false;
}

// otpauth:// URI for authenticator-app enrollment (and QR encoding client-side).
export function otpauthUrl(secret, account, issuer = 'BusinessTinder') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// One-time recovery codes. We return the plaintext to the user once and store
// only SHA-256 hashes.
export function generateRecoveryCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i += 1) {
    codes.push(crypto.randomBytes(5).toString('hex')); // 10 hex chars
  }
  return codes;
}
export function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code || '').trim().toLowerCase()).digest('hex');
}
