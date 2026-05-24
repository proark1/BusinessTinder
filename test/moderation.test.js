import test from 'node:test';
import assert from 'node:assert/strict';
import { moderateText, moderateImage } from '../backend/src/moderation.js';

const dataUrl = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

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

test('moderateImage accepts PNG/JPEG/WebP with matching magic bytes', () => {
  assert.equal(moderateImage(dataUrl('image/png', PNG)).ok, true);
  assert.equal(moderateImage(dataUrl('image/jpeg', JPEG)).ok, true);
  assert.equal(moderateImage(dataUrl('image/webp', WEBP)).ok, true);
});

test('moderateImage rejects bytes that do not match the declared type', () => {
  assert.equal(moderateImage(dataUrl('image/png', JPEG)).ok, false); // jpeg bytes labeled png
  assert.equal(moderateImage(dataUrl('image/webp', PNG)).ok, false);
});

test('moderateImage rejects non-image and unsupported types', () => {
  assert.equal(moderateImage('data:image/svg+xml;base64,PHN2Zy8+').ok, false);
  assert.equal(moderateImage('not a data url').ok, false);
  assert.equal(moderateImage('').ok, false);
});

test('moderateImage trusts https URLs (remote bytes not fetched here)', () => {
  assert.equal(moderateImage('https://cdn.example.com/a.jpg').ok, true);
});
