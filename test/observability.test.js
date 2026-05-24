import test from 'node:test';
import assert from 'node:assert/strict';
import { reportError, requestId } from '../backend/src/observability.js';

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

test('reportError is a no-op (does not throw) when no sink is configured', () => {
  assert.doesNotThrow(() => reportError(new Error('boom'), { foo: 'bar' }));
});

test('requestId middleware assigns req.id and echoes it on the response', () => {
  const req = { headers: {} };
  let headerVal;
  const res = { setHeader: (k, v) => { if (k.toLowerCase() === 'x-request-id') headerVal = v; } };
  let nexted = false;
  requestId(req, res, () => { nexted = true; });
  assert.ok(typeof req.id === 'string' && req.id.length > 0);
  assert.equal(headerVal, req.id);
  assert.ok(nexted);
});

test('responses carry a generated X-Request-Id header', async () => {
  const res = await fetch(`${base}/health`);
  const id = res.headers.get('x-request-id');
  assert.ok(id && id.length > 0);
});

test('an upstream X-Request-Id is preserved end-to-end', async () => {
  const res = await fetch(`${base}/health`, { headers: { 'X-Request-Id': 'corr-abc-123' } });
  assert.equal(res.headers.get('x-request-id'), 'corr-abc-123');
});

test('/ops/readiness reports the errorReporting check', async () => {
  const res = await fetch(`${base}/ops/readiness`);
  const body = await res.json();
  assert.ok(body.checks.some((c) => c.key === 'errorReporting'));
});
