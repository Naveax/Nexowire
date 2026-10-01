import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deniedMcpToolNames,
  isMcpToolAuthorized,
  normalizeToolPatterns,
  requestedMcpToolNames,
  toolPatternMatches,
} from '../src/security/tool-authorization.js';
import type { BearerAuthorization } from '../src/security/auth.js';

test('tool authorization patterns are normalized and prefix-bounded', () => {
  assert.deepEqual(
    normalizeToolPatterns([
      'machine_*',
      'files_read',
      'machine_*',
    ]),
    ['machine_*', 'files_read'],
  );

  assert.equal(toolPatternMatches('*', 'anything'), true);
  assert.equal(
    toolPatternMatches('machine_*', 'machine_snapshot'),
    true,
  );
  assert.equal(
    toolPatternMatches('machine_*', 'files_read'),
    false,
  );
  assert.equal(
    toolPatternMatches('files_read', 'files_read'),
    true,
  );
  assert.equal(
    toolPatternMatches('files_read', 'files_read_many'),
    false,
  );

  assert.throws(() =>
    normalizeToolPatterns(['files_*_dangerous']),
  );
});

test('stored credential tool allowlists restrict MCP calls while static credentials stay unrestricted', () => {
  const stored: BearerAuthorization = {
    kind: 'stored',
    scope: 'mcp',
    credential: {
      id: 'credential1234',
      scope: 'mcp',
      name: 'limited',
      createdAt: '2026-09-30T12:00:00.000Z',
      allowedTools: ['machine_*', 'files_read'],
    },
  };
  const staticAuth: BearerAuthorization = {
    kind: 'static',
    scope: 'mcp',
  };

  assert.equal(
    isMcpToolAuthorized(stored, 'machine_snapshot'),
    true,
  );
  assert.equal(
    isMcpToolAuthorized(stored, 'files_read'),
    true,
  );
  assert.equal(
    isMcpToolAuthorized(stored, 'files_write'),
    false,
  );
  assert.equal(
    isMcpToolAuthorized(stored, 'policy_profile_set'),
    false,
  );
  assert.equal(
    isMcpToolAuthorized(staticAuth, 'policy_profile_set'),
    true,
  );
  assert.equal(
    isMcpToolAuthorized(undefined, 'policy_profile_set'),
    true,
  );
});

test('tool-call request inspection handles single and batched JSON-RPC requests', () => {
  const body = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'machine_snapshot',
        arguments: {},
      },
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'files_write',
        arguments: {},
      },
    },
  ];

  assert.deepEqual(requestedMcpToolNames(body), [
    'machine_snapshot',
    'files_write',
  ]);

  const authorization: BearerAuthorization = {
    kind: 'stored',
    scope: 'mcp',
    credential: {
      id: 'credential1234',
      scope: 'mcp',
      createdAt: '2026-09-30T12:00:00.000Z',
      allowedTools: ['machine_*'],
    },
  };

  assert.deepEqual(
    deniedMcpToolNames(body, authorization),
    ['files_write'],
  );
});


test('stored credential roles separate user, operator, and admin control-plane access', () => {
  const user: BearerAuthorization = {
    kind: 'stored',
    scope: 'mcp',
    credential: {
      id: 'credential9999',
      scope: 'mcp',
      createdAt: '2026-09-30T12:00:00.000Z',
      role: 'user',
    },
  };
  const operator: BearerAuthorization = {
    kind: 'stored',
    scope: 'mcp',
    credential: {
      id: 'credentialoperator',
      scope: 'mcp',
      createdAt: '2026-09-30T12:00:00.000Z',
      role: 'operator',
    },
  };
  const admin: BearerAuthorization = {
    kind: 'stored',
    scope: 'mcp',
    credential: {
      id: 'credentialadmin',
      scope: 'mcp',
      createdAt: '2026-09-30T12:00:00.000Z',
      role: 'admin',
    },
  };
  const legacyAdmin: BearerAuthorization = {
    kind: 'stored',
    scope: 'mcp',
    credential: {
      id: 'credentiallegacy',
      scope: 'mcp',
      createdAt: '2026-09-30T12:00:00.000Z',
      administrative: true,
    },
  };

  for (const tool of [
    'policy_profile_list',
    'policy_device_check',
    'operations_idempotency_list',
    'events_read',
    'audit_recent',
    'audit_query',
  ]) {
    assert.equal(isMcpToolAuthorized(user, tool), false, tool);
    assert.equal(isMcpToolAuthorized(operator, tool), true, tool);
    assert.equal(isMcpToolAuthorized(admin, tool), true, tool);
    assert.equal(
      isMcpToolAuthorized(legacyAdmin, tool),
      true,
      tool,
    );
  }

  for (const tool of [
    'policy_profile_set',
    'policy_profile_delete',
    'policy_device_bind',
    'policy_device_unbind',
    'device_alias_set',
    'device_group_delete',
    'device_route_policy_set',
  ]) {
    assert.equal(isMcpToolAuthorized(user, tool), false, tool);
    assert.equal(isMcpToolAuthorized(operator, tool), false, tool);
    assert.equal(isMcpToolAuthorized(admin, tool), true, tool);
    assert.equal(
      isMcpToolAuthorized(legacyAdmin, tool),
      true,
      tool,
    );
  }

  for (const tool of [
    'devices_list',
    'device_route',
    'device_route_policy_list',
    'device_route_policy_resolve',
    'machine_snapshot',
    'file_read',
  ]) {
    assert.equal(isMcpToolAuthorized(user, tool), true, tool);
    assert.equal(isMcpToolAuthorized(operator, tool), true, tool);
    assert.equal(isMcpToolAuthorized(admin, tool), true, tool);
  }
});

