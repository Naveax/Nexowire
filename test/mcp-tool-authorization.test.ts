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
