import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTECTED_SECRET_PURPOSES,
} from '../src/security/protected-secrets-cli.js';

test('protected-secret CLI exposes control-plane and billing deployment purposes', () => {
  for (const purpose of [
    'control-plane-service-token',
    'billing-lemonsqueezy-api-key',
    'billing-lemonsqueezy-webhook-secret',
  ] as const) {
    assert.equal(
      PROTECTED_SECRET_PURPOSES.includes(purpose),
      true,
    );
  }
});
