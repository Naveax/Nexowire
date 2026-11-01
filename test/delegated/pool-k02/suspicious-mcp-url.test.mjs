import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

// Offline user-copy QA of the actual, read-only MCP address display function.
// No real fetch, OAuth, pairing, Hub or Agent is contacted.
const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/connect.js'), 'utf8');

function extractFunction(name) {
  const marker = `async function ${name}() {`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `${name} not found`);
  let depth = 0;
  for (let i = start + marker.length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') depth--;
    if (depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} missing closing brace`);
}

const functionUnderTest = extractFunction('loadChatGPTSetup');

async function display(resource, options = {}) {
  const nodes = {
    'chatgpt-address': { value: 'STALE_ADDRESS' },
    'copy-chatgpt-address': { disabled: false },
    'chatgpt-status': { textContent: 'STALE_SUCCESS' },
  };
  const fetchCalls = [];
  const origin = 'https://control.example.test';
  const context = {
    URL,
    $: (id) => {
      assert.ok(nodes[id], `unexpected DOM access: ${id}`);
      return nodes[id];
    },
    window: { location: { origin } },
    AbortSignal: { timeout: (ms) => ({ syntheticTimeoutMs: ms }) },
    fetch: async (path, init) => {
      fetchCalls.push({ path, init });
      return {
        status: options.status ?? 200,
        ok: options.status === undefined || (options.status >= 200 && options.status < 300),
        redirected: options.redirected ?? false,
        headers: { get: () => options.contentType ?? 'application/json' },
        json: async () => ({
          resource,
          authorization_servers: options.authorizationServers ?? [origin],
        }),
      };
    },
  };
  await vm.runInNewContext(`let chatgptAddress = '';\n${functionUnderTest}\nloadChatGPTSetup();`, context, { timeout: 1000 });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].path, '/.well-known/oauth-protected-resource');
  assert.equal(fetchCalls[0].init.credentials, 'omit');
  assert.equal(fetchCalls[0].init.redirect, 'error');
  return nodes;
}

const unsafeResources = [
  ['plain HTTP', 'http://mcp.example.test/mcp'],
  ['local hostname', 'https://localhost/mcp'],
  ['loopback IPv4', 'https://127.0.0.1/mcp'],
  ['loopback IPv6', 'https://[::1]/mcp'],
  ['embedded password', 'https://user:pass@mcp.example.test/mcp'],
  ['secret query', 'https://mcp.example.test/mcp?token=DO_NOT_ECHO'],
  ['fragment', 'https://mcp.example.test/mcp#DO_NOT_ECHO'],
  ['invalid URL', '::::'],
  ['blank resource', ''],
];

for (const [name, resource] of unsafeResources) {
  test(`invalid resource (${name}) is not exposed or described as ready`, async () => {
    const nodes = await display(resource);
    assert.equal(nodes['chatgpt-address'].value, '');
    assert.equal(nodes['copy-chatgpt-address'].disabled, true);
    const copy = nodes['chatgpt-status'].textContent;
    assert.match(copy, /Rastgele adresle ilerleme/);
    assert.doesNotMatch(copy, /DO_NOT_ECHO|user:pass|http:\/\/|localhost|127\.0\.0\.1/);
    assert.doesNotMatch(copy, /OAuth'u kapat|güvenlik.*kapat|kimlik doğrulama.*kapat/i);
  });
}

test('metadata from an unexpected authorization server fails closed with safe copy', async () => {
  const nodes = await display('https://mcp.example.test/mcp', {
    authorizationServers: ['https://different.example.test'],
  });
  assert.equal(nodes['chatgpt-address'].value, '');
  assert.equal(nodes['copy-chatgpt-address'].disabled, true);
  assert.match(nodes['chatgpt-status'].textContent, /Rastgele adresle ilerleme/);
});

test('HTTP 503 has diagnostic status without implying Windows reinstall or success', async () => {
  const nodes = await display('https://mcp.example.test/mcp?token=DO_NOT_ECHO', { status: 503 });
  assert.equal(nodes['chatgpt-address'].value, '');
  assert.equal(nodes['copy-chatgpt-address'].disabled, true);
  assert.match(nodes['chatgpt-status'].textContent, /HTTP 503/);
  assert.match(nodes['chatgpt-status'].textContent, /Windows kurulumunu tekrarlama/);
  assert.doesNotMatch(nodes['chatgpt-status'].textContent, /DO_NOT_ECHO/);
});

test('redirected or non-JSON response never leaves a stale copyable address', async () => {
  for (const options of [{ redirected: true }, { contentType: 'text/html' }]) {
    const nodes = await display('https://mcp.example.test/mcp', options);
    assert.equal(nodes['chatgpt-address'].value, '');
    assert.equal(nodes['copy-chatgpt-address'].disabled, true);
    assert.match(nodes['chatgpt-status'].textContent, /Rastgele adresle ilerleme/);
  }
});

// These are UI copy/shape checks only. A valid HTTPS URL plus metadata does
// NOT establish official publisher identity, real OAuth trust or live service.
