import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  BearerAuthorization,
} from '../src/security/auth.js';
import {
  directlyAuthorizedDeviceIds,
  hasMcpTargetRestrictions,
  isRoutingPolicyAuthorized,
} from '../src/security/target-authorization.js';

test('hosted account with zero devices is restricted to zero devices, not unrestricted', () => {
  const authorization: BearerAuthorization = {
    kind: 'control-plane',
    scope: 'mcp',
    accountId: 'acct-empty',
    role: 'user',
    allowedDeviceIds: [],
  };

  assert.equal(
    hasMcpTargetRestrictions(authorization),
    true,
  );
  assert.deepEqual(
    directlyAuthorizedDeviceIds(authorization),
    [],
  );
  assert.equal(
    isRoutingPolicyAuthorized(
      authorization,
      'some-policy',
    ),
    false,
  );
});

test('hosted account sees only explicit account device IDs', () => {
  const authorization: BearerAuthorization = {
    kind: 'control-plane',
    scope: 'mcp',
    accountId: 'acct-1',
    role: 'user',
    allowedDeviceIds: [
      'device-1',
      'device-2',
    ],
  };

  assert.equal(
    hasMcpTargetRestrictions(authorization),
    true,
  );
  assert.deepEqual(
    directlyAuthorizedDeviceIds(authorization),
    ['device-1', 'device-2'],
  );
});
