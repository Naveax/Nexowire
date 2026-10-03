import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTECTED_SECRET_PURPOSES,
} from '../src/security/protected-secrets-cli.js';

test('protected-secret CLI exposes the control-plane service token purpose', () => {
  assert.equal(
    PROTECTED_SECRET_PURPOSES.includes(
      'control-plane-service-token',
    ),
    true,
  );
});
