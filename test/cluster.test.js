import test from 'node:test';
import assert from 'node:assert/strict';

// No REDIS_URL in tests → the cluster layer must be a complete no-op so the
// server runs exactly as single-node.
delete process.env.REDIS_URL;

const { clusterEnabled, initCluster, publishDelivery, presenceAdd, presenceRemove, isOnlineAnywhere, instanceId } =
  await import('../backend/src/cluster.js');

test('cluster is disabled without REDIS_URL', async () => {
  const started = await initCluster(() => {});
  assert.equal(started, false);
  assert.equal(clusterEnabled(), false);
});

test('every cluster export is a safe no-op when disabled', async () => {
  assert.doesNotThrow(() => publishDelivery('u1', { type: 'message' }));
  await assert.doesNotReject(presenceAdd('u1'));
  await assert.doesNotReject(presenceRemove('u1'));
  assert.equal(await isOnlineAnywhere('u1'), false);
});

test('each process gets a stable instance id', () => {
  assert.ok(typeof instanceId === 'string' && instanceId.length > 0);
});
