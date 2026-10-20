import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  createNexowireMcpExpressApp,
  NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES,
} from '../src/mcp/http-app.js';

// Isolated loopback fixture. Never sends a live MCP tool, token, Agent command
// or file. Verifies SDK 1.32.1's 100 KiB parser regression without changing
// transport, credential, or production configuration.
test('issue #588: bounded MCP HTTP JSON admits 221 KiB Base64 and rejects over 512 KiB', async () => {
  const app = createNexowireMcpExpressApp({
    host: '127.0.0.1',
    allowedHosts: ['127.0.0.1', 'localhost'],
  });
  app.post('/mcp', (req, res) => {
    res.json({ size: typeof req.body?.payload === 'string' ? req.body.payload.length : 0 });
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/mcp`;

    // 221 KiB binary has a 301,740-char Base64 encoding, larger than the
    // old SDK factory's 102,400-byte request limit.
    const base64 = Buffer.alloc(221 * 1024).toString('base64');
    const admissible = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: base64 }),
    });
    assert.equal(admissible.status, 200);
    assert.deepEqual(await admissible.json(), { size: base64.length });

    const overLimit = JSON.stringify({
      payload: 'x'.repeat(NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES),
    });
    assert.ok(Buffer.byteLength(overLimit) > NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES);
    const rejected = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: overLimit,
    });
    assert.equal(rejected.status, 413, 'MCP must retain a finite per-request cap');

    const deniedHost = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'attacker.invalid' },
      body: overLimit,
    });
    assert.equal(deniedHost.status, 403,
      'DNS rebinding Host rejection must run before JSON body parsing');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});
