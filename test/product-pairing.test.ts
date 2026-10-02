import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consumePairingChallenge,
  createPairingChallenge,
} from '../src/product/pairing.js';

test('pairing stores only a digest and reveals the raw token once', () => {
  const now = new Date('2026-10-02T12:00:00.000Z');
  const challenge = createPairingChallenge(
    'acct_123',
    'gaming-pc',
    { now },
  );

  assert.match(challenge.token, /^nwx_pair_/);
  assert.equal(challenge.record.tokenHash.includes(challenge.token), false);
  assert.equal(challenge.record.consumedAt, null);
});

test('pairing token is single-use', () => {
  const now = new Date('2026-10-02T12:00:00.000Z');
  const challenge = createPairingChallenge(
    'acct_123',
    'gaming-pc',
    { now },
  );

  const first = consumePairingChallenge(
    challenge.record,
    challenge.token,
    new Date(now.getTime() + 1_000),
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;

  assert.deepEqual(
    consumePairingChallenge(
      first.record,
      challenge.token,
      new Date(now.getTime() + 2_000),
    ),
    { ok: false, reason: 'already-consumed' },
  );
});

test('pairing fails closed on expiry or a wrong token', () => {
  const now = new Date('2026-10-02T12:00:00.000Z');
  const challenge = createPairingChallenge(
    'acct_123',
    'gaming-pc',
    { now, ttlMs: 30_000 },
  );

  assert.deepEqual(
    consumePairingChallenge(
      challenge.record,
      'nwx_pair_not-the-token',
      new Date(now.getTime() + 1_000),
    ),
    { ok: false, reason: 'invalid-token' },
  );

  assert.deepEqual(
    consumePairingChallenge(
      challenge.record,
      challenge.token,
      new Date(now.getTime() + 30_000),
    ),
    { ok: false, reason: 'expired' },
  );
});
