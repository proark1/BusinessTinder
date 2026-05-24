import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

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
    redirect: 'manual',
  });
  let parsed = null;
  const text = await res.text();
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, headers: res.headers };
}
async function newUser(email) {
  const r = await j('POST', '/auth/register', { email, password: 'goodpass1', fullName: 'N' });
  return { token: r.body.token, user: r.body.user };
}

test('free / disposable email domains are rejected for company verification', async () => {
  const u = await newUser('cv-free@x.com');
  const gmail = await j('POST', '/me/company-email', { email: 'someone@gmail.com' }, u.token);
  assert.equal(gmail.status, 400);
  const junk = await j('POST', '/me/company-email', { email: 'not-an-email' }, u.token);
  assert.equal(junk.status, 400);
});

test('a work email can be submitted and then verified via the link', async () => {
  const u = await newUser('cv-work@x.com');
  const start = await j('POST', '/me/company-email', { email: 'avery@acme.io' }, u.token);
  assert.equal(start.status, 200);
  assert.equal(start.body.companyDomain, 'acme.io');
  assert.ok(start.body.verifyUrl, 'dev mode should surface the verify link');

  // Not verified yet.
  const me1 = await j('GET', '/me', null, u.token);
  assert.equal(me1.body.user.companyVerified, false);

  // Follow the verification link (redirects to the app).
  const token = start.body.verifyUrl.split('token=')[1];
  const verify = await j('GET', `/company/verify?token=${token}`);
  assert.equal(verify.status, 302);

  const me2 = await j('GET', '/me', null, u.token);
  assert.equal(me2.body.user.companyVerified, true);
  assert.equal(me2.body.user.companyDomain, 'acme.io');
});

test('an invalid verification token is rejected', async () => {
  const bad = await j('GET', '/company/verify?token=nope');
  assert.equal(bad.status, 404);
});

test('company-verified badge surfaces to other users in discover', async () => {
  const viewer = await newUser('cv-viewer@x.com');
  const target = await newUser('cv-target@x.com');
  await j('POST', '/profiles', {
    headline: 'X', userType: 'founder', bio: 'b', stage: 'mvp', location: 'Berlin',
    industries: ['AI'], lookingFor: ['cofounder'],
  }, viewer.token);
  await j('POST', '/profiles', {
    headline: 'Y', userType: 'cofounder_search', bio: 'b', stage: 'mvp', location: 'Berlin',
    industries: ['AI'], lookingFor: ['cofounder'],
  }, target.token);
  const start = await j('POST', '/me/company-email', { email: 'founder@acme.io' }, target.token);
  await j('GET', `/company/verify?token=${start.body.verifyUrl.split('token=')[1]}`);

  const disc = await j('GET', '/discover', null, viewer.token);
  const card = disc.body.find((p) => p.userId === target.user.id);
  assert.ok(card, 'target appears in discover');
  assert.equal(card.companyVerified, true);
  assert.equal(card.companyDomain, 'acme.io');
});
