import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeRemoteBinding, isLoopbackHost, loadConfig } from '../src/config.js';

test('loopback host detection accepts local forms', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});

test('remote bind requires both MCP and agent credentials', () => {
  const base = loadConfig({ NEXOWIRE_HTTP_HOST: '0.0.0.0', NEXOWIRE_HTTP_PORT: '43110' }, process.cwd());
  assert.throws(() => assertSafeRemoteBinding(base));
  assert.doesNotThrow(() => assertSafeRemoteBinding({ ...base, mcpBearerToken: 'mcp-secret', agentToken: 'agent-secret' }));
});
