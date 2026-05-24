import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test'; // bypass rate limits
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ADMIN_EMAILS = 'ts-admin@x.com'; // isAdminEmail() reads this live

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
async function newUser(email, fullName) {
  const r = await j('POST', '/auth/register', { email, password: 'secret123', fullName });
  return { token: r.body.token, user: r.body.user };
}
async function publishProfile(token, overrides = {}) {
  const r = await j('POST', '/profiles', {
    headline: 'X', userType: 'founder', bio: 'b', stage: 'mvp',
    industries: ['AI'], skills: ['Engineering'], location: 'Berlin', lookingFor: ['cofounder'], ...overrides,
  }, token);
  return r.body;
}
// Register-or-login the configured admin, regardless of test order.
async function getAdminToken() {
  const li = await j('POST', '/auth/login', { email: 'ts-admin@x.com', password: 'secret123' });
  if (li.status === 200) return li.body.token;
  const reg = await j('POST', '/auth/register', { email: 'ts-admin@x.com', password: 'secret123', fullName: 'Admin' });
  return reg.body.token;
}

test('admin can ban a user, who then cannot log in; unban restores access', async () => {
  const admin = await getAdminToken();
  const target = await newUser('ts-banme@x.com', 'Target');

  const ban = await j('POST', '/admin/ban', { userId: target.user.id, reason: 'spam' }, admin);
  assert.equal(ban.status, 200);

  const login = await j('POST', '/auth/login', { email: 'ts-banme@x.com', password: 'secret123' });
  assert.equal(login.status, 403);
  assert.match(login.body.error, /suspended/i);

  const unban = await j('POST', '/admin/unban', { userId: target.user.id }, admin);
  assert.equal(unban.status, 200);
  const login2 = await j('POST', '/auth/login', { email: 'ts-banme@x.com', password: 'secret123' });
  assert.equal(login2.status, 200);
});

test('banned users disappear from discover', async () => {
  const admin = await getAdminToken();
  const viewer = await newUser('ts-viewer@x.com', 'Viewer');
  const target = await newUser('ts-hidden@x.com', 'Hidden');
  await publishProfile(viewer.token);
  await publishProfile(target.token);

  const before = await j('GET', '/discover', null, viewer.token);
  assert.ok(before.body.some((p) => p.userId === target.user.id), 'target visible before ban');

  const ban = await j('POST', '/admin/ban', { userId: target.user.id }, admin);
  assert.equal(ban.status, 200);

  const after = await j('GET', '/discover', null, viewer.token);
  assert.ok(!after.body.some((p) => p.userId === target.user.id), 'target hidden after ban');
});

test('banned users cannot swipe', async () => {
  const admin = await getAdminToken();
  const target = await newUser('ts-swiper@x.com', 'Swiper');
  const other = await newUser('ts-other@x.com', 'Other');
  await publishProfile(other.token);
  await j('POST', '/admin/ban', { userId: target.user.id }, admin);
  const swipe = await j('POST', '/swipes', { toUserId: other.user.id, direction: 'RIGHT' }, target.token);
  assert.equal(swipe.status, 403);
});

test('non-admins cannot ban', async () => {
  const a = await newUser('ts-rando@x.com', 'Rando');
  const b = await newUser('ts-victim@x.com', 'Victim');
  const r = await j('POST', '/admin/ban', { userId: b.user.id }, a.token);
  assert.equal(r.status, 403);
});

test('admin can dismiss a report (status transitions OPEN → DISMISSED)', async () => {
  const admin = await getAdminToken();
  const reporter = await newUser('ts-reporter@x.com', 'Reporter');
  const target = await newUser('ts-reported@x.com', 'Reported');
  await j('POST', '/reports', { targetId: target.user.id, reason: 'spammy' }, reporter.token);

  const queue1 = await j('GET', '/admin/queue', null, admin);
  const report = queue1.body.reports.find((r) => r.targetId === target.user.id);
  assert.ok(report, 'report present in queue');
  assert.equal(report.status, 'OPEN');

  const resolve = await j('POST', `/admin/reports/${report.id}/resolve`, { status: 'DISMISSED' }, admin);
  assert.equal(resolve.status, 200);

  const queue2 = await j('GET', '/admin/queue', null, admin);
  const resolved = queue2.body.reports.find((r) => r.id === report.id);
  assert.equal(resolved.status, 'DISMISSED');
});

test('banning a user actions their open reports', async () => {
  const admin = await getAdminToken();
  const reporter = await newUser('ts-rep2@x.com', 'Reporter2');
  const target = await newUser('ts-rep-target@x.com', 'RepTarget');
  await j('POST', '/reports', { targetId: target.user.id, reason: 'abuse' }, reporter.token);
  await j('POST', '/admin/ban', { userId: target.user.id }, admin);
  const queue = await j('GET', '/admin/queue', null, admin);
  const report = queue.body.reports.find((r) => r.targetId === target.user.id);
  assert.equal(report.status, 'ACTIONED');
});

test('profile photos with mismatched magic bytes are rejected', async () => {
  const u = await newUser('ts-photo@x.com', 'Photo');
  const jpegBytesLabeledPng = `data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')}`;
  const r = await j('POST', '/profiles', {
    headline: 'X', userType: 'founder', bio: 'b', stage: 'mvp', location: 'X',
    photos: [jpegBytesLabeledPng],
  }, u.token);
  assert.equal(r.status, 400);
});
