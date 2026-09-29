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

test('token lists merge legacy/current credentials for rotation', () => {
  const config = loadConfig(
    {
      NEXOWIRE_HTTP_HOST: '0.0.0.0',
      NEXOWIRE_HTTP_PORT: '43110',
      NEXOWIRE_MCP_BEARER_TOKEN: 'current-mcp',
      NEXOWIRE_MCP_BEARER_TOKENS: 'old-mcp,current-mcp,next-mcp',
      NEXOWIRE_AGENT_TOKEN: 'current-agent',
      NEXOWIRE_AGENT_TOKENS: 'old-agent,current-agent,next-agent',
    },
    process.cwd(),
  );

  assert.deepEqual(config.mcpBearerTokens, [
    'current-mcp',
    'old-mcp',
    'next-mcp',
  ]);
  assert.deepEqual(config.agentTokens, [
    'current-agent',
    'old-agent',
    'next-agent',
  ]);
  assert.doesNotThrow(() => assertSafeRemoteBinding(config));
});

test('remote bind accepts token sets even without legacy singular fields', () => {
  const config = loadConfig(
    {
      NEXOWIRE_HTTP_HOST: '0.0.0.0',
      NEXOWIRE_HTTP_PORT: '43110',
      NEXOWIRE_MCP_BEARER_TOKENS: 'mcp-a,mcp-b',
      NEXOWIRE_AGENT_TOKENS: 'agent-a,agent-b',
    },
    process.cwd(),
  );
  assert.doesNotThrow(() => assertSafeRemoteBinding(config));
});
