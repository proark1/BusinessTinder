import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../backend/server.js';

async function startWithFile(file) {
  const server = createServer({ dataFile: file });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

test('API persists data to file across restarts', async () => {
  const file = path.join(os.tmpdir(), `bt-db-${Date.now()}.json`);

  const one = await startWithFile(file);
  await fetch(`${one.base}/auth/signup`, { method: 'POST', body: JSON.stringify({ email: 'persist@test.com' }) });
  await new Promise((resolve) => one.server.close(resolve));

  const two = await startWithFile(file);
  const profiles = await (await fetch(`${two.base}/profiles`)).json();
  const health = await (await fetch(`${two.base}/health`)).json();
  assert.equal(health.ok, true);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.users.length, 1);
  assert.equal(Array.isArray(profiles), true);
  await new Promise((resolve) => two.server.close(resolve));

  fs.unlinkSync(file);
});
