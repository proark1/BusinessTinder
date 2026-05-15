import test from 'node:test';
import assert from 'node:assert/strict';
import { moderateText } from '../backend/src/moderation.js';

test('empty input is allowed', () => {
  assert.equal(moderateText('').action, 'allow');
  assert.equal(moderateText(null).action, 'allow');
});

test('clean text is allowed', () => {
  const r = moderateText("Hey, I'm building an AI tool for finance teams.");
  assert.equal(r.ok, true);
  assert.equal(r.action, 'allow');
});

test('hard-blocked terms are rejected', () => {
  const r = moderateText('Send me your gift card to receive the prize');
  assert.equal(r.ok, false);
  assert.equal(r.action, 'block');
});

test('soft flags pass with action=flag', () => {
  const r = moderateText('Urgent inheritance opportunity for you');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'flag');
  assert.ok(r.flags.length > 0);
});

test('case-insensitive matching', () => {
  assert.equal(moderateText('Wire Transfer me now').ok, false);
});
