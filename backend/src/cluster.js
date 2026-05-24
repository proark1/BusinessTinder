// Optional Redis-backed cross-instance fan-out + presence for WebSocket
// delivery. Activated only when REDIS_URL is set; otherwise every export is a
// graceful no-op and the server behaves exactly as the single-node default.
//
// ioredis is imported lazily so the dependency is only needed when REDIS_URL is
// configured (mirrors the optional web-push pattern).

import crypto from 'node:crypto';

const REDIS_URL = process.env.REDIS_URL || '';
const CHANNEL = 'bt:ws';
const PRESENCE_TTL = 90; // seconds
const INSTANCE_ID = crypto.randomUUID();

let pub = null;
let sub = null;
let enabled = false;

export const clusterEnabled = () => enabled;
export const instanceId = INSTANCE_ID;

// Connect to Redis and start relaying remote deliveries to `deliverLocally`.
// Safe to call unconditionally; returns false (and stays a no-op) when there's
// no REDIS_URL, the driver is missing, or the connection fails.
export async function initCluster(deliverLocally) {
  if (!REDIS_URL) return false;
  let Redis;
  try {
    ({ default: Redis } = await import('ioredis'));
  } catch {
    console.warn('[cluster] REDIS_URL set but `ioredis` is not installed — running single-node.');
    return false;
  }
  try {
    pub = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
    sub = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
    pub.on('error', (e) => console.warn('[cluster] redis pub error:', e?.message));
    sub.on('error', (e) => console.warn('[cluster] redis sub error:', e?.message));
    sub.on('message', (_ch, raw) => {
      try {
        const { origin, userId, payload } = JSON.parse(raw);
        if (origin === INSTANCE_ID) return; // this instance already delivered locally
        deliverLocally?.(userId, payload);
      } catch { /* ignore malformed */ }
    });
    await sub.subscribe(CHANNEL);
    enabled = true;
    console.log('[cluster] Redis pub/sub enabled — multi-node WebSocket delivery active.');
    return true;
  } catch (e) {
    console.warn('[cluster] redis init failed — running single-node:', e?.message);
    enabled = false;
    return false;
  }
}

// Fan a delivery out to the other instances. The caller is expected to have
// already delivered to its own local sockets.
export function publishDelivery(userId, payload) {
  if (!enabled || !pub) return;
  pub.publish(CHANNEL, JSON.stringify({ origin: INSTANCE_ID, userId, payload })).catch?.(() => {});
}

// Presence: track which instances currently hold a live socket for a user, so
// the message-delivery path knows whether to fall back to push/email.
export async function presenceAdd(userId) {
  if (!enabled || !pub) return;
  try {
    await pub.sadd(`bt:presence:${userId}`, INSTANCE_ID);
    await pub.expire(`bt:presence:${userId}`, PRESENCE_TTL);
  } catch { /* best effort */ }
}
export async function presenceRemove(userId) {
  if (!enabled || !pub) return;
  try { await pub.srem(`bt:presence:${userId}`, INSTANCE_ID); } catch { /* best effort */ }
}
export async function isOnlineAnywhere(userId) {
  if (!enabled || !pub) return false;
  try { return (await pub.scard(`bt:presence:${userId}`)) > 0; } catch { return false; }
}
