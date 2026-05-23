// Stateless helpers extracted from server.js. Pure (or near-pure) functions
// with no dependency on the request, the DB, or any module-level state — so
// they're trivially testable and reusable across route modules as we keep
// peeling work off the monolith.

import crypto from 'node:crypto';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape a string for safe interpolation into HTML (server-rendered profile
// pages, transactional emails). Mirrors the frontend `esc()` in script.js.
export function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Strict allow-list: only base64-encoded PNG/JPEG/WebP data URLs. Used at every
// boundary that accepts a photo (profile photos, chat image messages, upload
// route). Anything else — including SVG, GIF, plain URLs — must go through the
// /upload endpoint or be rejected.
export function isPhotoDataUrlSafe(v) {
  if (typeof v !== 'string') return false;
  return /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(v);
}

// Day bucket key in UTC for daily counters (swipes/day, like reveals/day,
// boost/day). ISO date prefix keeps it sortable and human-readable in logs.
export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// URL-safe slug used for /u/:slug public profile pages and similar.
// Caps at 40 chars so the URL stays sane even for long names.
export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// URL-safe random code (referral codes, slug suffixes, one-shot tokens).
// base64url already only emits URL-safe chars; we just truncate to n.
export function randomCode(n = 8) {
  return crypto.randomBytes(n).toString('base64url').slice(0, n);
}

// Resolve the user's currently-effective plan tier. A user can be marked
// 'PRO' in the DB but past their planExpiresAt — in which case they're
// effectively back to 'FREE' until they renew. Null planExpiresAt is
// treated as a permanent grant (used for admin-issued comps).
export function effectivePlanTier(user) {
  if (!user) return 'FREE';
  if (user.planTier === 'PRO') {
    if (!user.planExpiresAt) return 'PRO';
    if (new Date(user.planExpiresAt).getTime() > Date.now()) return 'PRO';
    return 'FREE';
  }
  return user.planTier || 'FREE';
}
