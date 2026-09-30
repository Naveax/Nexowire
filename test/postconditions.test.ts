import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { executePostconditions } from '../src/agent/postconditions.js';
import { PathPolicy } from '../src/agent/path-policy.js';

test('postconditions verify files without echoing searched text', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-postconditions-files-'),
  );
  const file = path.join(root, 'state.txt');
  await fs.writeFile(file, 'secret-needle-value', 'utf8');
  const policy = new PathPolicy([root]);

  try {
    const result = await executePostconditions(
      {
        assertions: [
          {
            id: 'exists',
            kind: 'file.exists',
            path: file,
          },
          {
            id: 'contains',
            kind: 'file.text_contains',
            path: file,
            needle: 'secret-needle',
          },
          {
            id: 'missing',
            kind: 'file.exists',
            path: path.join(root, 'missing.txt'),
            expected: false,
          },
        ],
      },
      policy,
    );

    assert.equal(result.data.ok, true);
    assert.equal(result.data.passed, 3);
    assert.equal(result.data.failed, 0);
    assert.equal(result.data.skipped, 0);

    const contains = result.data.results.find(
      (entry) => entry.id === 'contains',
    );
    assert.ok(contains);
    assert.equal(contains.passed, true);
    assert.equal(contains.observed.contains, true);
    assert.equal('needle' in contains.observed, false);
    assert.match(
      String(contains.observed.needleSha256),
      /^[a-f0-9]{64}$/,
    );

    assert.doesNotMatch(
      JSON.stringify(result),
      /secret-needle-value/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('postconditions verify process, TCP, and HTTP state in parallel', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-postconditions-net-'),
  );
  const policy = new PathPolicy([root]);

  const tcpServer = net.createServer();
  await new Promise<void>((resolve) =>
    tcpServer.listen(0, '127.0.0.1', resolve),
  );
  const tcpAddress = tcpServer.address();
  assert.ok(tcpAddress && typeof tcpAddress === 'object');

  const httpServer = createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, '127.0.0.1', resolve),
  );
  const httpAddress = httpServer.address();
  assert.ok(httpAddress && typeof httpAddress === 'object');

  t.after(async () => {
    await new Promise<void>((resolve) =>
      tcpServer.close(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      httpServer.close(() => resolve()),
    );
    await fs.rm(root, { recursive: true, force: true });
  });

  const result = await executePostconditions(
    {
      max_parallel: 3,
      assertions: [
        {
          id: 'pid',
          kind: 'process.pid_alive',
          pid: process.pid,
        },
        {
          id: 'tcp',
          kind: 'tcp.open',
          host: '127.0.0.1',
          port: tcpAddress.port,
        },
        {
          id: 'http',
          kind: 'http.status',
          url: 'http://127.0.0.1:' + httpAddress.port + '/',
          expected_status: [204],
        },
      ],
    },
    policy,
  );

  assert.equal(result.data.ok, true);
  assert.equal(result.data.passed, 3);
});

test('stop_on_failure marks untouched assertions as skipped', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-postconditions-stop-'),
  );
  const policy = new PathPolicy([root]);

  try {
    const result = await executePostconditions(
      {
        max_parallel: 1,
        stop_on_failure: true,
        assertions: [
          {
            id: 'fail',
            kind: 'file.exists',
            path: path.join(root, 'missing.txt'),
          },
          {
            id: 'skip',
            kind: 'process.pid_alive',
            pid: process.pid,
          },
        ],
      },
      policy,
    );

    assert.equal(result.data.ok, false);
    assert.equal(result.data.passed, 0);
    assert.equal(result.data.failed, 1);
    assert.equal(result.data.skipped, 1);
    assert.equal(
      result.data.results[1]?.error?.code,
      'ASSERTION_SKIPPED',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
