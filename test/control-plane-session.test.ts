import test from 'node:test';
import assert from 'node:assert/strict';
import {
  issueOAuthState,
  issueSessionToken,
  verifyOAuthState,
  verifySessionToken,
} from '../src/product/control-plane-session.js';

const secret = '0123456789abcdef0123456789abcdef';

test('signed session round-trips and expires', () => {
  const now = new Date('2026-10-02T12:00:00.000Z');
  const token = issueSessionToken(
    { accountId: 'acct-1', role: 'user' },
    secret,
    { now, ttlSeconds: 120 },
  );

  assert.deepEqual(
    verifySessionToken(
      token,
      secret,
      new Date('2026-10-02T12:01:00.000Z'),
    ),
    { accountId: 'acct-1', role: 'user' },
  );
  assert.equal(
    verifySessionToken(
      token,
      secret,
      new Date('2026-10-02T12:02:00.000Z'),
    ),
    null,
  );
});

test('session signature tampering fails closed', () => {
  const token = issueSessionToken(
    { accountId: 'acct-1', role: 'user' },
    secret,
  );
  assert.equal(verifySessionToken(token + 'x', secret), null);
});

test('oauth state binds provider and sanitizes redirect', () => {
  const now = new Date('2026-10-02T12:00:00.000Z');
  const token = issueOAuthState(
    'github',
    '//evil.example',
    secret,
    { now, ttlSeconds: 120 },
  );

  assert.deepEqual(
    verifyOAuthState(
      token,
      'github',
      secret,
      new Date('2026-10-02T12:00:30.000Z'),
    ),
    { next: '/' },
  );
  assert.equal(
    verifyOAuthState(token, 'google', secret, now),
    null,
  );
});
