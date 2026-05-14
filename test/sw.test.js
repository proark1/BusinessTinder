import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('service worker precaches all core JS modules', () => {
  const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /\/src\/matchEngine\.js/);
  assert.match(sw, /\/src\/discovery\.js/);
  assert.match(sw, /\/src\/swipeState\.js/);
  assert.match(sw, /\/src\/portability\.js/);
});
