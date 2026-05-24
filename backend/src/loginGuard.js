// Per-identifier failed-login tracking with temporary lockout. In-memory and
// single-node for now (swap for Redis when scaling out). Keyed by lowercased
// email so it throttles targeted brute force regardless of source IP.

const MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS || 5);
const WINDOW_MS = Number(process.env.LOGIN_FAIL_WINDOW_MS || 15 * 60_000);
const LOCK_MS = Number(process.env.LOGIN_LOCK_MS || 15 * 60_000);

const attempts = new Map(); // key -> { fails, first, lockedUntil }
const keyFor = (id) => String(id || '').trim().toLowerCase();

export function loginLockState(id) {
  const rec = attempts.get(keyFor(id));
  if (rec?.lockedUntil && rec.lockedUntil > Date.now()) {
    return { locked: true, retryAfterMs: rec.lockedUntil - Date.now() };
  }
  return { locked: false };
}

export function recordLoginFailure(id) {
  const k = keyFor(id);
  const now = Date.now();
  let rec = attempts.get(k);
  if (!rec || now - rec.first > WINDOW_MS) rec = { fails: 0, first: now, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_FAILS) rec.lockedUntil = now + LOCK_MS;
  attempts.set(k, rec);
  return rec.lockedUntil > now ? { locked: true, retryAfterMs: rec.lockedUntil - now } : { locked: false };
}

export function clearLoginFailures(id) {
  attempts.delete(keyFor(id));
}

// Test seam to reset state between cases.
export function _resetLoginGuard() {
  attempts.clear();
}

// Drop stale entries so the map stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of attempts) {
    const expiry = Math.max(r.lockedUntil || 0, (r.first || 0) + WINDOW_MS);
    if (expiry < now) attempts.delete(k);
  }
}, 5 * 60_000).unref?.();
