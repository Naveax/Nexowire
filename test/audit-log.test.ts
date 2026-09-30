import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AuditLog } from '../src/audit/log.js';

test('audit log persists operation metadata without payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-audit-'));
  const file = path.join(root, 'audit.jsonl');
  const audit = new AuditLog(file);

  await audit.write({
    operationId: 'op-1',
    status: 'started',
    capability: 'shell.exec',
    targetId: 'device-1',
  });
  await audit.write({
    operationId: 'op-1',
    status: 'succeeded',
    capability: 'shell.exec',
    targetId: 'device-1',
    providerId: 'native-agent',
    durationMs: 12,
  });

  const raw = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(raw, /command|input|payload/i);

  const restored = new AuditLog(file);
  await restored.loadRecent();
  const events = restored.list(10);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.status, 'succeeded');
  assert.equal(events[1]?.status, 'started');
  assert.ok(events.every((event) => event.operationId === 'op-1'));
});


test('persistent audit query filters newest-first across restart', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-audit-query-'),
  );
  const file = path.join(root, 'audit.jsonl');

  try {
    const audit = new AuditLog(file, 2);

    await audit.write({
      operationId: 'op-1',
      status: 'started',
      capability: 'files.read',
      targetId: 'device-a',
      providerId: 'native-agent',
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await audit.write({
      operationId: 'op-1',
      status: 'succeeded',
      capability: 'files.read',
      targetId: 'device-a',
      providerId: 'native-agent',
      durationMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await audit.write({
      operationId: 'op-2',
      status: 'failed',
      capability: 'shell.exec',
      targetId: 'device-b',
      providerId: 'native-agent',
      errorCode: 'TEST_FAILURE',
    });

    const reloaded = new AuditLog(file, 1);
    await reloaded.loadRecent(1);

    assert.equal(reloaded.list(10).length, 1);

    const history = await reloaded.query({
      operationId: 'op-1',
      capability: 'files.read',
      limit: 10,
    });

    assert.equal(history.events.length, 2);
    assert.deepEqual(
      history.events.map((event) => event.status),
      ['succeeded', 'started'],
    );
    assert.ok(history.fileBytes > 0);
    assert.ok(history.scannedBytes > 0);
    assert.equal(history.truncatedByScanLimit, false);

    const failures = await reloaded.query({
      status: 'failed',
      targetId: 'device-b',
    });
    assert.equal(failures.events.length, 1);
    assert.equal(failures.events[0]?.operationId, 'op-2');
    assert.equal(failures.events[0]?.errorCode, 'TEST_FAILURE');

    const succeededAt = history.events[0]!.at;
    const windowed = await reloaded.query({
      fromAt: succeededAt,
      toAt: succeededAt,
      limit: 10,
    });
    assert.ok(
      windowed.events.some(
        (event) =>
          event.operationId === 'op-1' &&
          event.status === 'succeeded',
      ),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('persistent audit query stays bounded on large logs and ignores partial lines', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-audit-bounded-'),
  );
  const file = path.join(root, 'audit.jsonl');

  try {
    const lines: string[] = [];
    for (let index = 0; index < 3000; index++) {
      lines.push(
        JSON.stringify({
          id: 'id-' + index,
          operationId: 'op-' + index,
          at: new Date(1_700_000_000_000 + index).toISOString(),
          status: index % 2 === 0 ? 'succeeded' : 'failed',
          capability: 'machine.snapshot',
          targetId: 'device-' + (index % 4),
        }),
      );
    }
    await fs.writeFile(
      file,
      lines.join('\n') + '\n{"partial":',
      'utf8',
    );

    const audit = new AuditLog(file);
    const result = await audit.query({
      limit: 25,
      maxScanBytes: 65_536,
    });

    assert.equal(result.events.length, 25);
    assert.equal(result.scannedBytes, 65_536);
    assert.equal(result.truncatedByScanLimit, true);
    assert.ok(result.fileBytes > result.scannedBytes);
    assert.equal(result.events[0]?.operationId, 'op-2999');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('persistent audit query rejects invalid timestamp filters', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-audit-time-'),
  );

  try {
    const audit = new AuditLog(path.join(root, 'audit.jsonl'));
    await assert.rejects(
      () => audit.query({ fromAt: 'definitely-not-a-date' }),
      /Invalid audit fromAt timestamp/,
    );
    await assert.rejects(
      () => audit.query({ toAt: 'still-not-a-date' }),
      /Invalid audit toAt timestamp/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
