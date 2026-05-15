import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test'; // bypass rate limit + keep dev-mode tokens
process.env.JWT_SECRET = 'test-secret';

const { app } = await import('../backend/src/server.js');
const { createServer } = await import('node:http');

let server, base;
test.before(async () => {
  server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
});

async function j(method, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, text };
}

async function newUser(email, fullName) {
  const r = await j('POST', '/auth/register', { email, password: 'secret123', fullName });
  return { token: r.body.token, user: r.body.user, verifyUrl: r.body.verifyUrl };
}
async function publishProfile(token, overrides = {}) {
  const r = await j('POST', '/profiles', {
    headline: 'X', userType: 'founder', bio: 'b', stage: 'mvp',
    industries: ['AI'], skills: ['Engineering'], location: 'Berlin',
    lookingFor: ['cofounder'], ...overrides,
  }, token);
  return r.body;
}

test('register returns a verifyUrl in dev mode', async () => {
  const r = await newUser('verify@x.com', 'V');
  assert.ok(r.verifyUrl?.startsWith('/auth/verify?token='));
  assert.equal(r.user.emailVerified, false);
});

test('verify endpoint flips emailVerified', async () => {
  const r = await newUser('verify2@x.com', 'V2');
  const token = r.verifyUrl.split('token=')[1];
  const verifyRes = await fetch(`${base}/auth/verify?token=${token}`, { redirect: 'manual' });
  assert.equal(verifyRes.status, 302);
  const me = await j('GET', '/me', null, r.token);
  assert.equal(me.body.user.emailVerified, true);
});

test('forgot + reset password flow rotates the password', async () => {
  const r = await newUser('reset@x.com', 'R');
  const f = await j('POST', '/auth/forgot', { email: 'reset@x.com' });
  assert.equal(f.status, 200);
  assert.ok(f.body.resetUrl?.startsWith('/?reset='));
  const resetToken = f.body.resetUrl.split('reset=')[1];
  const out = await j('POST', '/auth/reset', { token: resetToken, password: 'newpass1' });
  assert.equal(out.status, 200);
  // Old password should fail; new password should succeed.
  const fail = await j('POST', '/auth/login', { email: 'reset@x.com', password: 'secret123' });
  assert.equal(fail.status, 401);
  const ok = await j('POST', '/auth/login', { email: 'reset@x.com', password: 'newpass1' });
  assert.equal(ok.status, 200);
});

test('forgot for unknown email still returns OK (no enumeration)', async () => {
  const r = await j('POST', '/auth/forgot', { email: 'nope@nowhere.com' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('photo data URLs only accept png/jpeg/webp base64', async () => {
  const u = await newUser('photo@x.com', 'P');
  // SVG should be rejected
  const bad = await j('POST', '/profiles', {
    headline: 'X', userType: 'founder', bio: 'b', stage: 'mvp', location: 'X',
    photos: ['data:image/svg+xml;base64,PHN2Zy8+'],
  }, u.token);
  assert.equal(bad.status, 400);
  // PNG OK
  const ok = await j('POST', '/profiles', {
    headline: 'X', userType: 'founder', bio: 'b', stage: 'mvp', location: 'X',
    photos: ['data:image/png;base64,iVBORw0KGgo='],
  }, u.token);
  assert.equal(ok.status, 200);
});

test('/likes/incoming is locked for FREE and unlocked after upgrade', async () => {
  const a = await newUser('likes-a@x.com', 'A');
  const b = await newUser('likes-b@x.com', 'B');
  await publishProfile(a.token); await publishProfile(b.token);
  await j('POST', '/swipes', { toUserId: b.user.id, direction: 'RIGHT' }, a.token);
  const locked = await j('GET', '/likes/incoming', null, b.token);
  assert.equal(locked.body.locked, true);
  assert.equal(locked.body.count, 1);
  await j('POST', '/plan/upgrade', null, b.token);
  const unlocked = await j('GET', '/likes/incoming', null, b.token);
  assert.equal(unlocked.body.locked, false);
  assert.equal(unlocked.body.profiles.length, 1);
});

test('SUPER_LIKE direction matches with mutual RIGHT and surfaces a flag', async () => {
  const a = await newUser('sl-a@x.com', 'A');
  const b = await newUser('sl-b@x.com', 'B');
  await publishProfile(a.token); await publishProfile(b.token);
  // A super-likes B → /discover for B shows superLikedYou=true
  await j('POST', '/swipes', { toUserId: b.user.id, direction: 'SUPER_LIKE' }, a.token);
  const disc = await j('GET', '/discover', null, b.token);
  assert.ok(disc.body.length >= 1);
  const aProf = disc.body.find((p) => p.userId === a.user.id);
  assert.equal(aProf?.superLikedYou, true);
  // B swipes RIGHT → match
  const swipe = await j('POST', '/swipes', { toUserId: a.user.id, direction: 'RIGHT' }, b.token);
  assert.equal(swipe.body.matched, true);
});

test('referral payout grants both inviter and invitee 30d PRO', async () => {
  const inviter = await newUser('ref-inv@x.com', 'I');
  const invitee = await j('POST', '/auth/register', {
    email: 'ref-new@x.com', password: 'secret123', fullName: 'N',
    referredBy: inviter.user.referralCode,
  });
  assert.equal(invitee.body.user.planTier, 'PRO');
  const inviterMe = await j('GET', '/me', null, inviter.token);
  assert.equal(inviterMe.body.user.planTier, 'PRO');
});

test('blocks: POST then GET then DELETE', async () => {
  const a = await newUser('blk-a@x.com', 'A');
  const b = await newUser('blk-b@x.com', 'B');
  await publishProfile(b.token);
  await j('POST', '/blocks', { targetId: b.user.id }, a.token);
  const list = await j('GET', '/blocks', null, a.token);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].targetId, b.user.id);
  await j('DELETE', `/blocks/${b.user.id}`, null, a.token);
  const empty = await j('GET', '/blocks', null, a.token);
  assert.equal(empty.body.length, 0);
});

test('blocked user cannot message into the conversation', async () => {
  const a = await newUser('mb-a@x.com', 'A');
  const b = await newUser('mb-b@x.com', 'B');
  await publishProfile(a.token); await publishProfile(b.token);
  await j('POST', '/swipes', { toUserId: b.user.id, direction: 'RIGHT' }, a.token);
  await j('POST', '/swipes', { toUserId: a.user.id, direction: 'RIGHT' }, b.token);
  const ms = await j('GET', '/matches', null, a.token);
  const convId = ms.body[0].conversation.id;
  await j('POST', '/blocks', { targetId: b.user.id }, a.token);
  const fromA = await j('POST', `/messages/${convId}`, { body: 'hi' }, a.token);
  assert.equal(fromA.status, 403);
  const fromB = await j('POST', `/messages/${convId}`, { body: 'hi' }, b.token);
  assert.equal(fromB.status, 403);
});

test('chat pagination returns most recent N with before cursor', async () => {
  const a = await newUser('pg-a@x.com', 'A');
  const b = await newUser('pg-b@x.com', 'B');
  await publishProfile(a.token); await publishProfile(b.token);
  await j('POST', '/swipes', { toUserId: b.user.id, direction: 'RIGHT' }, a.token);
  await j('POST', '/swipes', { toUserId: a.user.id, direction: 'RIGHT' }, b.token);
  const ms = await j('GET', '/matches', null, a.token);
  const convId = ms.body[0].conversation.id;
  for (let i = 0; i < 10; i += 1) {
    await j('POST', `/messages/${convId}`, { body: `m${i}` }, a.token);
  }
  const page1 = await j('GET', `/messages/${convId}?limit=4`, null, b.token);
  assert.equal(page1.body.length, 4);
  assert.equal(page1.body[3].body, 'm9');
  const olderCursor = page1.body[0].id;
  const page2 = await j('GET', `/messages/${convId}?limit=4&before=${olderCursor}`, null, b.token);
  assert.ok(page2.body.length > 0);
  assert.ok(page2.body[page2.body.length - 1].body < page1.body[0].body);
});

test('account deletion removes user and their data', async () => {
  const u = await newUser('del@x.com', 'D');
  await publishProfile(u.token);
  await j('DELETE', '/me', null, u.token);
  const after = await j('GET', '/me', null, u.token);
  assert.equal(after.status, 404);
});

test('/conversations/:id/read marks all incoming messages as READ', async () => {
  const a = await newUser('rd-a@x.com', 'A');
  const b = await newUser('rd-b@x.com', 'B');
  await publishProfile(a.token); await publishProfile(b.token);
  await j('POST', '/swipes', { toUserId: b.user.id, direction: 'RIGHT' }, a.token);
  await j('POST', '/swipes', { toUserId: a.user.id, direction: 'RIGHT' }, b.token);
  const ms = await j('GET', '/matches', null, a.token);
  const convId = ms.body[0].conversation.id;
  await j('POST', `/messages/${convId}`, { body: 'hi' }, a.token);
  const bMatches1 = await j('GET', '/matches', null, b.token);
  assert.equal(bMatches1.body[0].unreadCount, 1);
  await j('POST', `/conversations/${convId}/read`, null, b.token);
  const bMatches2 = await j('GET', '/matches', null, b.token);
  assert.equal(bMatches2.body[0].unreadCount, 0);
});

test('headline moderation rejects banned terms', async () => {
  const u = await newUser('mod-h@x.com', 'M');
  const r = await j('POST', '/profiles', {
    headline: 'send me your gift card', userType: 'founder', bio: 'b', stage: 'mvp', location: 'X',
  }, u.token);
  assert.equal(r.status, 400);
});
