import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPhotoDataUrlSafe,
  todayKey,
  slugify,
  randomCode,
  effectivePlanTier,
} from '../backend/src/helpers.js';

test('isPhotoDataUrlSafe accepts PNG/JPEG/WebP base64 data URLs', () => {
  assert.equal(isPhotoDataUrlSafe('data:image/png;base64,AAAA'), true);
  assert.equal(isPhotoDataUrlSafe('data:image/jpeg;base64,AAAA'), true);
  assert.equal(isPhotoDataUrlSafe('data:image/jpg;base64,AAAA'), true);
  assert.equal(isPhotoDataUrlSafe('data:image/webp;base64,AAAA'), true);
});

test('isPhotoDataUrlSafe rejects everything else', () => {
  assert.equal(isPhotoDataUrlSafe(null), false);
  assert.equal(isPhotoDataUrlSafe(undefined), false);
  assert.equal(isPhotoDataUrlSafe(42), false);
  assert.equal(isPhotoDataUrlSafe(''), false);
  assert.equal(isPhotoDataUrlSafe('not a data url'), false);
  assert.equal(isPhotoDataUrlSafe('https://example.com/cat.png'), false);
  // SVG would let HTML/JS through — must be rejected.
  assert.equal(isPhotoDataUrlSafe('data:image/svg+xml;base64,AAAA'), false);
  // GIF not in allow-list.
  assert.equal(isPhotoDataUrlSafe('data:image/gif;base64,AAAA'), false);
  // Plain (non-base64) data URLs not accepted.
  assert.equal(isPhotoDataUrlSafe('data:image/png,not-base64'), false);
  // Empty payload after the marker.
  assert.equal(isPhotoDataUrlSafe('data:image/png;base64,'), false);
});

test('todayKey returns ISO YYYY-MM-DD', () => {
  const k = todayKey();
  assert.match(k, /^\d{4}-\d{2}-\d{2}$/);
  // Sanity: matches what new Date() produces right now.
  assert.equal(k, new Date().toISOString().slice(0, 10));
});

test('slugify lowercases, collapses non-alphanumeric, trims, and caps length', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  Mixed __ CASE  '), 'mixed-case');
  assert.equal(slugify('Émile & Co!!!'), 'mile-co'); // non-ASCII stripped
  assert.equal(slugify('---leading and trailing---'), 'leading-and-trailing');
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  // Cap at 40 chars.
  const long = slugify('a'.repeat(100));
  assert.equal(long.length, 40);
});

test('randomCode returns URL-safe string of requested length', () => {
  const a = randomCode(8);
  const b = randomCode(8);
  assert.equal(a.length, 8);
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.equal(randomCode(4).length, 4);
  assert.equal(randomCode(16).length, 16);
});

test('effectivePlanTier handles missing user, FREE, and PRO with no expiry', () => {
  assert.equal(effectivePlanTier(null), 'FREE');
  assert.equal(effectivePlanTier({}), 'FREE');
  assert.equal(effectivePlanTier({ planTier: 'FREE' }), 'FREE');
  assert.equal(effectivePlanTier({ planTier: 'PRO' }), 'PRO'); // null expiry = permanent
});

test('effectivePlanTier respects planExpiresAt', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(effectivePlanTier({ planTier: 'PRO', planExpiresAt: future }), 'PRO');
  assert.equal(effectivePlanTier({ planTier: 'PRO', planExpiresAt: past }), 'FREE');
});
