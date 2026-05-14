import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../backend/server.js';

async function j(res) { return res.json(); }

test('API supports signup, profile, swipe match, and messages', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const u1 = await j(await fetch(`${base}/auth/signup`, { method: 'POST', body: JSON.stringify({ email: 'a@a.com' }) }));
  const u2 = await j(await fetch(`${base}/auth/signup`, { method: 'POST', body: JSON.stringify({ email: 'b@b.com' }) }));
  assert.equal(u1.id, '1');
  assert.equal(u2.id, '2');

  const p = await j(await fetch(`${base}/profiles`, { method: 'POST', body: JSON.stringify({ userId: u1.id, name: 'A' }) }));
  assert.equal(p.userId, '1');

  await fetch(`${base}/swipes`, { method: 'POST', body: JSON.stringify({ fromUserId: '1', toUserId: '2', direction: 'right' }) });
  await fetch(`${base}/swipes`, { method: 'POST', body: JSON.stringify({ fromUserId: '2', toUserId: '1', direction: 'right' }) });
  const matches = await j(await fetch(`${base}/matches?userId=1`));
  assert.equal(matches.length, 1);

  const msg = await j(await fetch(`${base}/messages`, { method: 'POST', body: JSON.stringify({ matchId: matches[0].id, fromUserId: '1', text: 'hi' }) }));
  assert.equal(msg.text, 'hi');
  const msgs = await j(await fetch(`${base}/messages?matchId=${matches[0].id}`));
  assert.equal(msgs.length, 1);

  const report = await j(await fetch(`${base}/reports`, { method: 'POST', body: JSON.stringify({ fromUserId: '1', targetUserId: '2', reason: 'spam' }) }));
  assert.equal(report.targetUserId, '2');

  const block = await j(await fetch(`${base}/blocks`, { method: 'POST', body: JSON.stringify({ fromUserId: '1', targetUserId: '2' }) }));
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

test('API validates payloads and returns 400 on invalid JSON', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const badSignup = await fetch(`${base}/auth/signup`, { method: 'POST', body: '{}' });
  assert.equal(badSignup.status, 400);

  const badJson = await fetch(`${base}/profiles`, { method: 'POST', body: '{bad-json' });
  assert.equal(badJson.status, 400);

  const badSwipe = await fetch(`${base}/swipes`, { method: 'POST', body: JSON.stringify({ fromUserId: '1' }) });
  assert.equal(badSwipe.status, 400);

  await new Promise((resolve) => server.close(resolve));
});
