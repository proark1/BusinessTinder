import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeState, parseImportedState } from '../src/portability.js';

test('serializeState returns valid JSON string', () => {
  const json = serializeState({ a: 1 });
  assert.equal(typeof json, 'string');
  assert.equal(JSON.parse(json).a, 1);
});

test('parseImportedState normalizes missing fields', () => {
  const out = parseImportedState('{"matches":[{"id":1}]}');
  assert.deepEqual(out.matches, [{ id: 1 }]);
  assert.deepEqual(out.passed, []);
  assert.equal(out.me, null);
});
