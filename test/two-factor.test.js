import test from 'node:test';
import assert from 'node:assert/strict';
import { totp } from '../backend/src/totp.js';

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
  });
  let parsed = null;
  try { parsed = JSON.parse(await res.text()); } catch {}
  return { status: res.status, body: parsed };
}
async function newUser(email) {
  const r = await j('POST', '/auth/register', { email, password: 'goodpass1', fullName: 'N' });
  return { token: r.body.token, user: r.body.user };
}
async function enroll(token) {
  const setup = await j('POST', '/me/2fa/setup', null, token);
  const enable = await j('POST', '/me/2fa/enable', { code: totp(setup.body.secret) }, token);
  return { secret: setup.body.secret, recoveryCodes: enable.body.recoveryCodes };
}

test('enabling 2FA requires a correct code and returns recovery codes', async () => {
  const u = await newUser('mfa-enable@x.com');
  const setup = await j('POST', '/me/2fa/setup', null, u.token);
  assert.ok(setup.body.secret && setup.body.otpauthUrl);
  const bad = await j('POST', '/me/2fa/enable', { code: '000000' }, u.token);
  assert.equal(bad.status, 400);
  const ok = await j('POST', '/me/2fa/enable', { code: totp(setup.body.secret) }, u.token);
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.recoveryCodes) && ok.body.recoveryCodes.length >= 8);
});

test('login becomes two-step once 2FA is on', async () => {
  const u = await newUser('mfa-login@x.com');
  const { secret } = await enroll(u.token);

  const login = await j('POST', '/auth/login', { email: 'mfa-login@x.com', password: 'goodpass1' });
  assert.equal(login.body.mfaRequired, true);
  assert.ok(login.body.mfaToken);
  assert.ok(!login.body.token, 'no session token before the second factor');

  const wrong = await j('POST', '/auth/2fa', { mfaToken: login.body.mfaToken, code: '000000' });
  assert.equal(wrong.status, 401);

  const step = await j('POST', '/auth/2fa', { mfaToken: login.body.mfaToken, code: totp(secret) });
  assert.equal(step.status, 200);
  assert.ok(step.body.token);
  assert.equal(step.body.user.twoFactorEnabled, true);
});

test('a recovery code authenticates once, then is burned', async () => {
  const u = await newUser('mfa-recovery@x.com');
  const { recoveryCodes } = await enroll(u.token);
  const code = recoveryCodes[0];

  const login1 = await j('POST', '/auth/login', { email: 'mfa-recovery@x.com', password: 'goodpass1' });
  const use1 = await j('POST', '/auth/2fa', { mfaToken: login1.body.mfaToken, code });
  assert.equal(use1.status, 200);
  assert.equal(use1.body.recoveryCodeUsed, true);

  const login2 = await j('POST', '/auth/login', { email: 'mfa-recovery@x.com', password: 'goodpass1' });
  const use2 = await j('POST', '/auth/2fa', { mfaToken: login2.body.mfaToken, code });
  assert.equal(use2.status, 401, 'a recovery code cannot be reused');
});

test('disabling 2FA restores single-factor login', async () => {
  const u = await newUser('mfa-disable@x.com');
  const { secret } = await enroll(u.token);
  const off = await j('POST', '/me/2fa/disable', { code: totp(secret) }, u.token);
  assert.equal(off.status, 200);
  const login = await j('POST', '/auth/login', { email: 'mfa-disable@x.com', password: 'goodpass1' });
  assert.ok(login.body.token);
  assert.ok(!login.body.mfaRequired);
});
