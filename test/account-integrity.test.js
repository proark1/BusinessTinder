import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test'; // bypass IP rate limits (login lockout still active)
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
  const text = await res.text();
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, headers: res.headers };
}
const register = (email, password) => j('POST', '/auth/register', { email, password, fullName: 'N' });

test('registration enforces the password policy', async () => {
  assert.equal((await register('ai-short@x.com', 'short')).status, 400);       // < 8 chars
  assert.equal((await register('ai-common@x.com', 'password123')).status, 400); // too common
  assert.equal((await register('ai-repeat@x.com', 'aaaaaaaa')).status, 400);    // single repeated char
  const good = await register('ai-good@x.com', 'goodpass1');
  assert.equal(good.status, 200);
  assert.ok(good.body.token);
});

test('repeated failed logins lock the account, then block even a correct password', async () => {
  const email = 'ai-lock@x.com';
  await register(email, 'correct1horse');
  // 5 wrong attempts: the first 4 are 401, the 5th trips the lockout (429).
  for (let i = 0; i < 4; i += 1) {
    const r = await j('POST', '/auth/login', { email, password: 'wrongpass' });
    assert.equal(r.status, 401, `attempt ${i + 1} should be 401`);
  }
  const fifth = await j('POST', '/auth/login', { email, password: 'wrongpass' });
  assert.equal(fifth.status, 429);
  // Locked out: even the correct password is refused until the cooldown passes.
  const correct = await j('POST', '/auth/login', { email, password: 'correct1horse' });
  assert.equal(correct.status, 429);
});

test('a successful login before lockout clears the failure counter', async () => {
  const email = 'ai-clear@x.com';
  await register(email, 'correct1horse');
  await j('POST', '/auth/login', { email, password: 'nope12345' }); // 1 failure
  await j('POST', '/auth/login', { email, password: 'nope12345' }); // 2 failures
  const ok = await j('POST', '/auth/login', { email, password: 'correct1horse' });
  assert.equal(ok.status, 200); // success clears the counter
  // Two more failures should NOT lock (counter was reset to 0).
  await j('POST', '/auth/login', { email, password: 'nope12345' });
  const stillOk = await j('POST', '/auth/login', { email, password: 'correct1horse' });
  assert.equal(stillOk.status, 200);
});

test('GET /me/export returns the user\'s data as a JSON attachment', async () => {
  const reg = await register('ai-export@x.com', 'goodpass1');
  const token = reg.body.token;
  await j('POST', '/profiles', {
    headline: 'X', userType: 'founder', bio: 'b', stage: 'mvp', location: 'Berlin',
    industries: ['AI'], lookingFor: ['cofounder'],
  }, token);

  const exp = await j('GET', '/me/export', null, token);
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-type') || '', /application\/json/);
  assert.match(exp.headers.get('content-disposition') || '', /attachment/);
  for (const key of ['account', 'profile', 'swipes', 'matches', 'conversations', 'messages', 'saved', 'blocks', 'reports']) {
    assert.ok(key in exp.body, `export missing "${key}"`);
  }
  assert.equal(exp.body.account.email, 'ai-export@x.com');
  assert.equal(exp.body.profile.headline, 'X');
});
