import test from 'node:test';
import assert from 'node:assert/strict';
import { applySwipe, undoLastSwipe } from '../src/swipeState.js';

const profile = { id: 1, rightSwipesYou: true };

test('applySwipe adds match on mutual right', () => {
  const out = applySwipe({ direction: 'right', current: profile, matches: [], passed: [], history: [] });
  assert.equal(out.matches.length, 1);
  assert.equal(out.passed.length, 0);
  assert.equal(out.history.length, 1);
});

test('applySwipe adds to passed on non-match', () => {
  const out = applySwipe({ direction: 'left', current: profile, matches: [], passed: [], history: [] });
  assert.deepEqual(out.passed, ['1']);
});

test('undoLastSwipe removes effects of last swipe', () => {
  const out = undoLastSwipe({
    matches: [{ id: 1 }],
    passed: ['1'],
    history: [{ id: 1, direction: 'right' }],
    chats: { '1': [{ from: 'me', text: 'hi' }] }
  });
  assert.equal(out.matches.length, 0);
  assert.equal(out.passed.length, 0);
  assert.equal(out.history.length, 0);
  assert.equal(out.chats['1'], undefined);
});


test('applySwipe right non-mutual adds to passed', () => {
  const out = applySwipe({ direction: 'right', current: { id: 2, rightSwipesYou: false }, matches: [], passed: [], history: [] });
  assert.deepEqual(out.passed, ['2']);
  assert.equal(out.matches.length, 0);
});
