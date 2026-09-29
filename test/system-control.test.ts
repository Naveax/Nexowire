import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeSystemCapability } from '../src/agent/system-control.js';

test('machine health returns bounded CPU, memory, uptime, and disk data', async () => {
  const result = (await executeSystemCapability('machine.health', {
    sample_ms: 100,
  })) as {
    data: {
      uptimeSeconds: number;
      cpu: { usagePercent: number; logicalCount: number; sampleMs: number };
      memory: {
        totalBytes: number;
        freeBytes: number;
        usedBytes: number;
        usedPercent: number;
      };
      disk: { path: string; usedPercent?: number; error?: string };
    };
  };

  assert.ok(result.data.uptimeSeconds >= 0);
  assert.ok(result.data.cpu.logicalCount >= 1);
  assert.equal(result.data.cpu.sampleMs, 100);
  assert.ok(result.data.cpu.usagePercent >= 0);
  assert.ok(result.data.cpu.usagePercent <= 100);
  assert.ok(result.data.memory.totalBytes > 0);
  assert.ok(result.data.memory.usedBytes >= 0);
  assert.ok(result.data.memory.usedPercent >= 0);
  assert.ok(result.data.memory.usedPercent <= 100);
  assert.ok(result.data.disk.path.length > 0);
  if (result.data.disk.usedPercent !== undefined) {
    assert.ok(result.data.disk.usedPercent >= 0);
    assert.ok(result.data.disk.usedPercent <= 100);
  }
});

test('DNS resolution returns structured localhost addresses', async () => {
  const result = (await executeSystemCapability('network.dns.resolve', {
    host: 'localhost',
  })) as {
    data: {
      resolved: boolean;
      durationMs: number;
      addresses: Array<{ address: string; family: number }>;
    };
  };

  assert.equal(result.data.resolved, true);
  assert.ok(result.data.durationMs >= 0);
  assert.ok(result.data.addresses.length >= 1);
  assert.ok(result.data.addresses.every((entry) => entry.address.length > 0));
});

test('TCP probe distinguishes a listening local endpoint', async (t) => {
  const server = createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const result = (await executeSystemCapability('network.tcp.probe', {
    host: '127.0.0.1',
    port: address.port,
    family: 'ipv4',
    timeout_ms: 2_000,
  })) as {
    data: {
      reachable: boolean;
      durationMs: number;
      remoteAddress?: string;
    };
  };

  assert.equal(result.data.reachable, true);
  assert.ok(result.data.durationMs >= 0);
  assert.equal(result.data.remoteAddress, '127.0.0.1');
});

test('HTTP probe supports HEAD, bounded GET bodies, and redirect policy', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.statusCode = 302;
      res.setHeader('location', '/final');
      res.end();
      return;
    }
    if (req.url === '/final') {
      res.setHeader('content-type', 'text/plain');
      res.end('final-body');
      return;
    }
    res.setHeader('content-type', 'text/plain');
    res.end('abcdefghijklmnopqrstuvwxyz');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const head = (await executeSystemCapability('network.http.probe', {
    url: base + '/',
    method: 'HEAD',
    timeout_ms: 2_000,
  })) as { data: { reachable: boolean; status: number; bytesRead: number } };
  assert.equal(head.data.reachable, true);
  assert.equal(head.data.status, 200);
  assert.equal(head.data.bytesRead, 0);

  const get = (await executeSystemCapability('network.http.probe', {
    url: base + '/',
    method: 'GET',
    max_body_bytes: 5,
    timeout_ms: 2_000,
  })) as {
    data: {
      reachable: boolean;
      status: number;
      body?: string;
      bytesRead: number;
      truncated: boolean;
    };
  };
  assert.equal(get.data.reachable, true);
  assert.equal(get.data.status, 200);
  assert.equal(get.data.body, 'abcde');
  assert.equal(get.data.bytesRead, 5);
  assert.equal(get.data.truncated, true);

  const manualRedirect = (await executeSystemCapability(
    'network.http.probe',
    {
      url: base + '/redirect',
      method: 'HEAD',
      follow_redirects: false,
      timeout_ms: 2_000,
    },
  )) as { data: { status: number; redirected: boolean; location: string | null } };
  assert.equal(manualRedirect.data.status, 302);
  assert.equal(manualRedirect.data.redirected, false);
  assert.equal(manualRedirect.data.location, '/final');

  const followed = (await executeSystemCapability('network.http.probe', {
    url: base + '/redirect',
    method: 'GET',
    follow_redirects: true,
    timeout_ms: 2_000,
  })) as {
    data: { status: number; redirected: boolean; body?: string; finalUrl: string };
  };
  assert.equal(followed.data.status, 200);
  assert.equal(followed.data.redirected, true);
  assert.equal(followed.data.body, 'final-body');
  assert.match(followed.data.finalUrl, /\/final$/);
});

test('HTTP probe rejects credential-bearing and non-HTTP URLs', async () => {
  await assert.rejects(
    () =>
      executeSystemCapability('network.http.probe', {
        url: 'http://user:secret@localhost/',
      }),
    /must not embed credentials/,
  );

  await assert.rejects(
    () =>
      executeSystemCapability('network.http.probe', {
        url: 'file:///etc/hosts',
      }),
    /http:\/\/ and https:\/\//,
  );
});
