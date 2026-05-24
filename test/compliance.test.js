import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SECRET = 'test-secret';
process.env.NODE_ENV = 'test'; // bypass rate limits
process.env.JWT_SECRET = SECRET; // this file imports backend/src/server.js first (alphabetical)

const { app } = await import('../backend/src/server.js');
const { createServer } = await import('node:http');

// Mirror the server's deterministic unsubscribe token (HMAC over the user id).
const unsubToken = (userId) => crypto.createHmac('sha256', SECRET).update(`unsub:${userId}`).digest('base64url');

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
  const text = await res.text();
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, text, contentType: res.headers.get('content-type') };
}
async function newUser(email) {
  const r = await j('POST', '/auth/register', { email, password: 'secret123', fullName: 'N' });
  return { token: r.body.token, user: r.body.user };
}

test('new users default to receiving activity emails', async () => {
  const u = await newUser('comp-default@x.com');
  assert.equal(u.user.emailOptOut, false);
});

test('POST /me/notifications toggles email opt-out, reflected in /me', async () => {
  const u = await newUser('comp-toggle@x.com');
  const off = await j('POST', '/me/notifications', { emailOptOut: true }, u.token);
  assert.equal(off.status, 200);
  assert.equal(off.body.emailOptOut, true);
  const me1 = await j('GET', '/me', null, u.token);
  assert.equal(me1.body.user.emailOptOut, true);

  const on = await j('POST', '/me/notifications', { emailOptOut: false }, u.token);
  assert.equal(on.body.emailOptOut, false);
  const me2 = await j('GET', '/me', null, u.token);
  assert.equal(me2.body.user.emailOptOut, false);
});

test('one-click /unsubscribe opts the user out with a valid token', async () => {
  const u = await newUser('comp-unsub@x.com');
  const good = await j('GET', `/unsubscribe?u=${encodeURIComponent(u.user.id)}&t=${unsubToken(u.user.id)}`);
  assert.equal(good.status, 200);
  assert.match(good.text, /unsubscribed/i);
  const me = await j('GET', '/me', null, u.token);
  assert.equal(me.body.user.emailOptOut, true);
});

test('/unsubscribe rejects a bad or missing token', async () => {
  const u = await newUser('comp-unsub-bad@x.com');
  const bad = await j('GET', `/unsubscribe?u=${encodeURIComponent(u.user.id)}&t=nope`);
  assert.equal(bad.status, 400);
  const me = await j('GET', '/me', null, u.token);
  assert.equal(me.body.user.emailOptOut, false); // unchanged
});

test('legal pages render as HTML', async () => {
  const terms = await j('GET', '/legal/terms');
  assert.equal(terms.status, 200);
  assert.match(terms.contentType || '', /text\/html/);
  assert.match(terms.text, /Terms of Service/);

  const privacy = await j('GET', '/legal/privacy');
  assert.equal(privacy.status, 200);
  assert.match(privacy.text, /Privacy Policy/);
});
