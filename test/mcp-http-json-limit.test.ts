import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import {
  createNexowireMcpExpressApp,
  NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES,
  NEXOWIRE_MCP_RESPONSE_BODY_LIMIT_BYTES,
} from '../src/mcp/http-app.js';

// Only loopback synthetic JSON. Never touches tokens, live Hub, Agent or files.
test('issue #588: 9.5 MiB request and response envelopes are bounded independently', async () => {
  const app = createNexowireMcpExpressApp({
    host: '127.0.0.1',
    allowedHosts: ['127.0.0.1', 'localhost'],
  });
  app.post('/mcp', (req, res) => {
    if (req.body?.mode === 'oversized-response') {
      res.json({ payload: 'R'.repeat(NEXOWIRE_MCP_RESPONSE_BODY_LIMIT_BYTES) });
      return;
    }
    if (req.body?.mode === 'streamed-response') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('s'.repeat(NEXOWIRE_MCP_RESPONSE_BODY_LIMIT_BYTES - 256));
      res.write('t'.repeat(512));
      res.end();
      return;
    }
    res.json({
      size: typeof req.body?.payload === 'string' ? req.body.payload.length : 0,
    });
  });

  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/mcp`;
    assert.equal(NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES, 9_961_472);
    assert.equal(NEXOWIRE_MCP_RESPONSE_BODY_LIMIT_BYTES, 9_961_472);

    const base64 = Buffer.alloc(221 * 1024).toString('base64');
    const admissible = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: base64 }),
    });
    assert.equal(admissible.status, 200);
    assert.deepEqual(await admissible.json(), { size: base64.length });

    const nearBody = JSON.stringify({
      payload: 'n'.repeat(NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES - 1024),
    });
    assert.ok(Buffer.byteLength(nearBody) < NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES);
    const nearLimit = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: nearBody,
    });
    assert.equal(nearLimit.status, 200);

    const overBody = JSON.stringify({
      payload: 'x'.repeat(NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES),
    });
    assert.ok(Buffer.byteLength(overBody) > NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES);
    const rejected = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: overBody,
    });
    assert.equal(rejected.status, 413);

    // Node HTTP request (not fetch): send an explicit raw hostile Host header.
    // Verify Host protection remains active before body parsing.
    const deniedHost = await new Promise<number>((resolve, reject) => {
      const client = request({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          Host: 'attacker.invalid',
          'Content-Type': 'application/json',
          'Content-Length': '2',
        },
      }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      client.on('error', reject);
      client.end('{}');
    });
    assert.equal(deniedHost, 403, 'unapproved Host must be rejected');

    const oversizedResponse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'oversized-response' }),
    });
    assert.equal(oversizedResponse.status, 413);
    const json = await oversizedResponse.json();
    assert.equal(json.code, 'MCP_RESPONSE_TOO_LARGE');
    assert.equal(json.mutation_state, 'unknown');
    assert.equal(json.automatically_retryable, false);

    await assert.rejects(async () => {
      const streamedResponse = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'streamed-response' }),
      });
      // Once SSE bytes are sent, abort rather than masquerading as success.
      await streamedResponse.text();
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
});
