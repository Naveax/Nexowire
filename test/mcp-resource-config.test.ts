import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
} from '../src/config.js';

test('MCP resource URL requires secure /mcp endpoint except loopback development', () => {
  const secure = loadConfig({
    NEXOWIRE_MCP_RESOURCE_URL:
      'https://relay.example.test/mcp',
  });
  assert.equal(
    secure.mcpResourceUrl,
    'https://relay.example.test/mcp',
  );

  const loopback = loadConfig({
    NEXOWIRE_MCP_RESOURCE_URL:
      'http://127.0.0.1:43110/mcp',
  });
  assert.equal(
    loopback.mcpResourceUrl,
    'http://127.0.0.1:43110/mcp',
  );

  assert.throws(
    () =>
      loadConfig({
        NEXOWIRE_MCP_RESOURCE_URL:
          'http://relay.example.test/mcp',
      }),
    /NEXOWIRE_MCP_RESOURCE_URL/,
  );
  assert.throws(
    () =>
      loadConfig({
        NEXOWIRE_MCP_RESOURCE_URL:
          'https://relay.example.test/not-mcp',
      }),
    /NEXOWIRE_MCP_RESOURCE_URL/,
  );
});
