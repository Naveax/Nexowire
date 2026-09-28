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
