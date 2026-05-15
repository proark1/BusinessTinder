import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestIcebreakers } from '../backend/src/icebreakers.js';

test('returns 3 prompts for a null profile', () => {
  const out = suggestIcebreakers(null);
  assert.equal(out.length, 3);
});

test('returns 3 prompts for empty profile', () => {
  assert.equal(suggestIcebreakers({}).length, 3);
});

test('first prompts are co-founder-themed when lookingFor=cofounder', () => {
  const out = suggestIcebreakers({ lookingFor: ['cofounder'] });
  assert.equal(out.length, 3);
  assert.ok(out[0].toLowerCase().includes('co-founder'));
});

test('first prompts are investor-themed when lookingFor=investors', () => {
  const out = suggestIcebreakers({ lookingFor: ['investors'] });
  assert.ok(out[0].toLowerCase().includes('round') || out[0].toLowerCase().includes('traction'));
});

test('falls back to generic for unknown lookingFor', () => {
  const out = suggestIcebreakers({ lookingFor: ['totally-unknown'] });
  assert.equal(out.length, 3);
});
