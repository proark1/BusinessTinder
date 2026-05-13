import test from 'node:test';
import assert from 'node:assert/strict';
import { decideMatch, profileCompletionPercent } from '../src/matchEngine.js';

test('right + right is a match', () => {
  assert.equal(decideMatch('right', true), true);
});

test('right + left is not a match', () => {
  assert.equal(decideMatch('right', false), false);
});

test('left + right is not a match', () => {
  assert.equal(decideMatch('left', true), false);
});

test('profile completion is 100 for full profile', () => {
  const profile = { name: 'A', role: 'B', bio: 'C', interests: 'D', goal: 'E', location: 'F' };
  assert.equal(profileCompletionPercent(profile), 100);
});


test('invalid direction throws', () => {
  assert.throws(() => decideMatch('up', true));
});

test('empty profile is 0%', () => {
  assert.equal(profileCompletionPercent(null), 0);
});
