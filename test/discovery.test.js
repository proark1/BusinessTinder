import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscoverPool } from '../src/discovery.js';

const profiles = [
  { id: 1, tags: ['AI'] },
  { id: 2, tags: ['Climate'] },
  { id: 3, tags: ['AI', 'HealthTech'] }
];

test('industry filter narrows results', () => {
  const pool = buildDiscoverPool({ profiles, industry: 'AI' });
  assert.deepEqual(pool.map((p) => p.id), [1, 3]);
});

test('reported, matched, and passed profiles are excluded', () => {
  const pool = buildDiscoverPool({
    profiles,
    industry: 'all',
    reported: ['1'],
    matches: [{ id: 2 }],
    passed: ['3']
  });
  assert.equal(pool.length, 0);
});
