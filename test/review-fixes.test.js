// Regression tests for the code-review hardening pass: input validation on
// swipes/blocks/reports, the 2FA step-up token not being accepted as a session
// token, and moderation word-boundary matching.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

// Minimal HS256 JWT signer so the test doesn't depend on the backend's
// jsonwebtoken (which isn't resolvable from the repo-root test context).
function signJwt(payload, secret) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ ...payload, iat: now, exp: now + 300 })}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

import { moderateText } from '../backend/src/moderation.js';

const { app } = await import('../backend/src/server.js');
const { createServer } = await import('node:http');

let server, base;
test.before(async () => {
  server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
});

async function j(method, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = JSON.parse(await res.text()); } catch {}
  return { status: res.status, body: parsed };
}
async function newUser(email) {
  const r = await j('POST', '/auth/register', { email, password: 'secret123', fullName: 'T' });
  return { token: r.body.token, user: r.body.user };
}

test('swipe: rejects missing/self/non-existent targets', async () => {
  const a = await newUser('rf-a@x.com');
  const miss = await j('POST', '/swipes', { direction: 'RIGHT' }, a.token);
  assert.equal(miss.status, 400);
  const self = await j('POST', '/swipes', { toUserId: a.user.id, direction: 'RIGHT' }, a.token);
  assert.equal(self.status, 400);
  const ghost = await j('POST', '/swipes', { toUserId: 'no-such-user', direction: 'RIGHT' }, a.token);
  assert.equal(ghost.status, 404);
});

test('swipe between two real users still matches', async () => {
  const a = await newUser('rf-m1@x.com');
  const b = await newUser('rf-m2@x.com');
  await j('POST', '/swipes', { toUserId: b.user.id, direction: 'RIGHT' }, a.token);
  const r = await j('POST', '/swipes', { toUserId: a.user.id, direction: 'RIGHT' }, b.token);
  assert.equal(r.body.matched, true);
});

test('blocks/reports reject self-targeting', async () => {
  const a = await newUser('rf-b@x.com');
  assert.equal((await j('POST', '/blocks', { targetId: a.user.id }, a.token)).status, 400);
  assert.equal((await j('POST', '/reports', { targetId: a.user.id }, a.token)).status, 400);
});

test('2FA step-up token cannot be used as a session token', async () => {
  const a = await newUser('rf-mfa@x.com');
  // A token carrying a `purpose` (like the pre-2FA mfaToken) must be rejected
  // on authenticated routes, or 2FA could be skipped entirely.
  const stepUp = signJwt({ userId: a.user.id, purpose: 'mfa' }, 'test-secret');
  const res = await j('GET', '/me', null, stepUp);
  assert.equal(res.status, 401);
  // A normal session token still works.
  assert.equal((await j('GET', '/me', null, a.token)).status, 200);
});

test('referral redeem is idempotent', async () => {
  const inviter = await newUser('rf-inv@x.com');
  const invitee = await newUser('rf-vee@x.com');
  const first = await j('POST', '/referrals/redeem', { code: inviter.user.referralCode }, invitee.token);
  assert.equal(first.status, 200);
  const second = await j('POST', '/referrals/redeem', { code: inviter.user.referralCode }, invitee.token);
  assert.equal(second.status, 400);
});

test('moderateText: word boundaries avoid substring false positives', () => {
  assert.equal(moderateText('I grew up in Sussex near Middlesex').ok, true);
  assert.equal(moderateText('We should denude the risk model').ok, true);
  // Real standalone terms are still blocked.
  assert.equal(moderateText('nude photos here').ok, false);
  assert.equal(moderateText('Wire Transfer me now').ok, false);
  assert.equal(moderateText('Send me your gift card').ok, false);
});
