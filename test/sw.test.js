import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('service worker precaches the shipped app shell', () => {
  const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\/index\.html'/);
  assert.match(sw, /'\/script\.js'/);
  assert.match(sw, /'\/styles\.css'/);
});

test('service worker does not precache the unbundled src/ modules (app never loads them)', () => {
  const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.doesNotMatch(sw, /\/src\//);
});
