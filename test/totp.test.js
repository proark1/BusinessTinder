import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecret, totp, verifyTotp, otpauthUrl, generateRecoveryCodes, hashRecoveryCode } from '../backend/src/totp.js';

test('a freshly generated code verifies, and a wrong one does not', () => {
  const secret = generateSecret();
  const code = totp(secret);
  assert.equal(verifyTotp(secret, code), true);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal(verifyTotp(secret, wrong), false);
});

test('codes from an adjacent 30s window still verify (clock skew tolerance)', () => {
  const secret = generateSecret();
  const now = Date.now();
  const prevWindow = totp(secret, now - 30_000);
  assert.equal(verifyTotp(secret, prevWindow, now), true);
});

test('a code from far in the past is rejected', () => {
  const secret = generateSecret();
  const old = totp(secret, Date.now() - 5 * 60_000);
  assert.equal(verifyTotp(secret, old, Date.now()), false);
});

test('verifyTotp rejects malformed input', () => {
  const secret = generateSecret();
  assert.equal(verifyTotp(secret, ''), false);
  assert.equal(verifyTotp(secret, 'abcdef'), false);
  assert.equal(verifyTotp(secret, '12345'), false);
  assert.equal(verifyTotp('', '123456'), false);
});

test('a known RFC 6238 vector matches', () => {
  // RFC 6238 test secret "12345678901234567890" => base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
  // At T=59s the SHA1/6-digit TOTP is 287082.
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082');
});

test('otpauthUrl encodes issuer + account', () => {
  const url = otpauthUrl('ABC234', 'me@acme.io');
  assert.match(url, /^otpauth:\/\/totp\//);
  assert.match(url, /secret=ABC234/);
  assert.match(url, /issuer=BusinessTinder/);
});

test('recovery codes hash deterministically (case/space-insensitive)', () => {
  const [c] = generateRecoveryCodes(1);
  assert.equal(hashRecoveryCode(c), hashRecoveryCode(` ${c.toUpperCase()} `));
});
