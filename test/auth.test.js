import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword, signToken, verifyToken } from '../backend/auth.js';

test('hashPassword/verifyPassword round-trips a valid password', () => {
  const stored = hashPassword('hunter2');
  assert.equal(verifyPassword('hunter2', stored), true);
});

test('verifyPassword rejects the wrong password', () => {
  const stored = hashPassword('hunter2');
  assert.equal(verifyPassword('wrong-password', stored), false);
});

test('signToken/verifyToken round-trips a payload', () => {
  const token = signToken({ sub: '42', email: 'a@a.com' });
  const decoded = verifyToken(token);
  assert.equal(decoded.sub, '42');
  assert.equal(decoded.email, 'a@a.com');
});

test('verifyToken returns null for tampered tokens', () => {
  const token = signToken({ sub: '1' });
  const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  assert.equal(verifyToken(tampered), null);
});

test('verifyToken returns null for malformed tokens', () => {
  assert.equal(verifyToken(''), null);
  assert.equal(verifyToken('no-dot'), null);
});

test('verifyPassword returns false for malformed stored values', () => {
  assert.equal(verifyPassword('hunter2', null), false);
  assert.equal(verifyPassword('hunter2', ''), false);
  assert.equal(verifyPassword('hunter2', 'no-colon'), false);
  assert.equal(verifyPassword('hunter2', 'salt:'), false);
  assert.equal(verifyPassword('hunter2', ':hash'), false);
});

test('verifyToken returns null for non-JSON payloads', () => {
  const data = Buffer.from('not-json').toString('base64url');
  const secret = process.env.BT_TOKEN_SECRET || 'dev-secret-change-me';
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  assert.equal(verifyToken(`${data}.${sig}`), null);
});
