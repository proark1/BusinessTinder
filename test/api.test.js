import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../backend/server.js';

async function j(res) { return res.json(); }

test('API supports auth, profile, swipe match, and messages', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const u1 = await j(await fetch(`${base}/auth/signup`, { method: 'POST', body: JSON.stringify({ email: 'a@a.com', password: 'pass1234' }) }));
  const u2 = await j(await fetch(`${base}/auth/signup`, { method: 'POST', body: JSON.stringify({ email: 'b@b.com', password: 'pass1234' }) }));
  assert.ok(u1.token);
  assert.ok(u2.token);

  const auth1 = { Authorization: `Bearer ${u1.token}`, 'Content-Type': 'application/json' };
  const auth2 = { Authorization: `Bearer ${u2.token}`, 'Content-Type': 'application/json' };

  const me = await j(await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${u1.token}` } }));
  assert.equal(me.userId, '1');

  const p = await j(await fetch(`${base}/profiles`, { method: 'POST', headers: auth1, body: JSON.stringify({ name: 'A' }) }));
  assert.equal(p.userId, '1');
  const myProfiles = await j(await fetch(`${base}/profiles/me`, { headers: { Authorization: `Bearer ${u1.token}` } }));
  assert.equal(myProfiles.length, 1);

  await fetch(`${base}/swipes`, { method: 'POST', headers: auth1, body: JSON.stringify({ toUserId: '2', direction: 'right' }) });
  await fetch(`${base}/swipes`, { method: 'POST', headers: auth2, body: JSON.stringify({ toUserId: '1', direction: 'right' }) });
  const matches = await j(await fetch(`${base}/matches`, { headers: { Authorization: `Bearer ${u1.token}` } }));
  assert.equal(matches.length, 1);

  const msg = await j(await fetch(`${base}/messages`, { method: 'POST', headers: auth1, body: JSON.stringify({ matchId: matches[0].id, text: 'hi' }) }));
  assert.equal(msg.text, 'hi');
  const msgs = await j(await fetch(`${base}/messages?matchId=${matches[0].id}`, { headers: { Authorization: `Bearer ${u1.token}` } }));
  assert.equal(msgs.length, 1);

  const report = await j(await fetch(`${base}/reports`, { method: 'POST', headers: auth1, body: JSON.stringify({ targetUserId: '2', reason: 'spam' }) }));
  assert.equal(report.targetUserId, '2');

  const block = await j(await fetch(`${base}/blocks`, { method: 'POST', headers: auth1, body: JSON.stringify({ targetUserId: '2' }) }));
  assert.equal(block.targetUserId, '2');

  await new Promise((resolve) => server.close(resolve));
});

test('API responds to CORS preflight', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/profiles`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');

  await new Promise((resolve) => server.close(resolve));
});

test('API validates payloads and returns 400/401', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const badSignup = await fetch(`${base}/auth/signup`, { method: 'POST', body: '{}' });
  assert.equal(badSignup.status, 400);

  const badJson = await fetch(`${base}/auth/signup`, { method: 'POST', body: '{bad-json' });
  assert.equal(badJson.status, 400);

  const unauthorized = await fetch(`${base}/matches`);
  assert.equal(unauthorized.status, 401);

  await new Promise((resolve) => server.close(resolve));
});


test('metrics endpoint returns aggregate counters', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${base}/auth/signup`, { method: 'POST', body: JSON.stringify({ email: 'm@a.com', password: 'pass1234' }) });
  const metrics = await (await fetch(`${base}/metrics`)).json();
  assert.equal(metrics.users, 1);

  await new Promise((resolve) => server.close(resolve));
});


test('API rate limiting returns 429 after threshold', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  let status = 200;
  for (let i = 0; i < 130; i++) {
    const res = await fetch(`${base}/health`);
    status = res.status;
    if (status === 429) break;
  }
  assert.equal(status, 429);

  await new Promise((resolve) => server.close(resolve));
});
