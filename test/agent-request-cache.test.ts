import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRequestCache,
  AgentRequestCacheError,
  fingerprintAgentRequest,
} from '../src/agent/request-cache.js';

test('agent request cache deduplicates matching in-flight and completed request IDs', async () => {
  const cache = new AgentRequestCache<{ value: number }>({
    ttlMs: 5_000,
  });
  const fingerprint = fingerprintAgentRequest(
    'files.write',
    { path: 'x.txt', content: 'hello' },
  );

  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = cache.run(
    '11111111-1111-4111-8111-111111111111',
    fingerprint,
    async () => {
      runs++;
      await gate;
      return { value: 42 };
    },
  );
  const duplicate = cache.run(
    '11111111-1111-4111-8111-111111111111',
    fingerprint,
    async () => {
      runs++;
      return { value: 99 };
    },
  );

  assert.equal(runs, 0);
  release();

  assert.deepEqual(await first, { value: 42 });
  assert.deepEqual(await duplicate, { value: 42 });
  assert.equal(runs, 1);

  const completedReplay = await cache.run(
    '11111111-1111-4111-8111-111111111111',
    fingerprint,
    async () => {
      runs++;
      return { value: 100 };
    },
  );
  assert.deepEqual(completedReplay, { value: 42 });
  assert.equal(runs, 1);
});

test('agent request cache rejects request ID reuse with different input', async () => {
  const cache = new AgentRequestCache<number>();
  const requestId = '22222222-2222-4222-8222-222222222222';

  await cache.run(
    requestId,
    fingerprintAgentRequest('files.write', { path: 'a' }),
    async () => 1,
  );

  await assert.rejects(
    () =>
      cache.run(
        requestId,
        fingerprintAgentRequest('files.write', { path: 'b' }),
        async () => 2,
      ),
    (error: unknown) =>
      error instanceof AgentRequestCacheError &&
      error.code === 'REQUEST_ID_REUSE_MISMATCH',
  );
});

test('agent request cache expires settled responses after TTL', async () => {
  let now = 1_000;
  const cache = new AgentRequestCache<number>({
    ttlMs: 5_000,
    now: () => now,
  });
  const requestId = '33333333-3333-4333-8333-333333333333';
  const fingerprint = fingerprintAgentRequest(
    'machine.snapshot',
    {},
  );

  let runs = 0;
  assert.equal(
    await cache.run(requestId, fingerprint, async () => ++runs),
    1,
  );
  now += 4_999;
  assert.equal(
    await cache.run(requestId, fingerprint, async () => ++runs),
    1,
  );
  now += 2;
  assert.equal(
    await cache.run(requestId, fingerprint, async () => ++runs),
    2,
  );
  assert.equal(runs, 2);
});
