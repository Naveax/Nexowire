import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AuthenticatedTransferRoute, TransferBinding, TransferCheckpoint,
} from '../src/mcp/cross-device-transfer-continuity.js';
import {
  inspectOneCallWorkerConnectionJournal,
  type FencedWorkerJournalSnapshot,
} from '../src/mcp/cross-device-worker-journal-link.js';

/** #691 source-only integration fixture. Neither SQLite nor these callbacks
 * are a production external CAS, signed Broker or Native write witness. */
const bytes = Buffer.alloc(65_536, 0x7b);
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function fixture(dispatched?: boolean) {
  const binding: TransferBinding = {
    jobId: randomUUID(), ownerId: 'fixture-owner', projectId: 'fixture-project',
    sourceDeviceId: 'source-fixture', destinationDeviceId: 'target-fixture',
    sourcePath: '/fixture/source', targetPath: '/fixture/target',
    stagePath: '/fixture/target.part', sourceSha256: digest(bytes),
    totalBytes: bytes.length,
  };
  const requestId = randomUUID();
  const checkpoint: TransferCheckpoint = {
    binding, revision: 9, epoch: 5, offset: 0, status: 'unknown',
    pending: { requestId, epoch: 4, offset: 0, length: bytes.length,
      sha256: digest(bytes), ackObserved: false },
  };
  const worker: FencedWorkerJournalSnapshot = {
    id: binding.jobId, accountId: binding.ownerId, projectId: binding.projectId,
    sourceDeviceId: binding.sourceDeviceId,
    targetDeviceId: binding.destinationDeviceId,
    sourcePath: binding.sourcePath, targetPath: binding.targetPath,
    stagePath: binding.stagePath, bytesTotal: binding.totalBytes,
    bytesConfirmed: 0, sha256: binding.sourceSha256,
    state: 'MUTATION_UNKNOWN',
    fencing: { epoch: 27, token: 'synthetic-external-only-lease-token-123456' },
    pending: { requestId, epoch: 27, offset: 0, length: bytes.length,
      sha256: digest(bytes), ...(dispatched === undefined ? {} : { dispatched }) },
  };
  const route: AuthenticatedTransferRoute = {
    ownerId: binding.ownerId, projectId: binding.projectId,
    sourceDeviceId: binding.sourceDeviceId,
    destinationDeviceId: binding.destinationDeviceId, epoch: 5,
  };
  return { worker, checkpoint, route };
}
type InspectInput = Parameters<typeof inspectOneCallWorkerConnectionJournal>[0];
const inspect = (
  f: ReturnType<typeof fixture>,
  changes: Partial<InspectInput> = {},
) => inspectOneCallWorkerConnectionJournal({
  worker: f.worker, checkpoint: f.checkpoint, route: f.route,
  authorize: async () => true,
  workerLease: { check: async () => true },
  sessionWitness: { currentEpoch: async () => 5 },
  stageReadback: {
    inspect: async (w, p) => ({
      kind: 'verified' as const, deviceId: w.targetDeviceId,
      offset: p.offset, length: p.length, sha256: p.sha256,
    }),
  },
  ...changes,
});

test('#691 durably reserved dispatched=false cannot adopt existing bytes or issue replay', async () => {
  const f = fixture(false);
  let reads = 0;
  const frozen = JSON.stringify(f);
  const result = await inspect(f, {
    stageReadback: { inspect: async (w, p) => {
      reads++;
      return { kind: 'verified' as const, deviceId: w.targetDeviceId,
        offset: p.offset, length: p.length, sha256: p.sha256 };
    } },
  });
  assert.equal(result.state, 'reservation_unresolved');
  assert.equal(reads, 0, 'no stage readback should certify a never-dispatched reservation');
  assert.equal(result.automaticallyReplayable, false);
  assert.equal(result.mutationExecuted, false);
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(f.checkpoint.offset, 0);
  assert.equal(JSON.stringify(f), frozen);
});

test('legacy missing dispatched flag is possibly sent, never conflated with false', async () => {
  const f = fixture();
  assert.equal((await inspect(f)).state, 'readback_verified_not_committed');
  const corrupted = await inspect(f, {
    stageReadback: { inspect: async (w, p) => ({
      kind: 'verified' as const, deviceId: w.targetDeviceId,
      offset: p.offset, length: p.length, sha256: '0'.repeat(64),
    }) },
  });
  assert.equal(corrupted.state, 'mutation_unknown');
  assert.equal(corrupted.automaticallyReplayable, false);
});

test('reopened WAL/FULL pending stays UNKNOWN across worker restart and stale receipt', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nw-06-691-wal-'));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const dbFile = path.join(dir, 'checkpoint.sqlite');
  const f = fixture(true);
  let db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; ' +
    'CREATE TABLE journal (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO journal VALUES (?,?)').run('worker', JSON.stringify(f.worker));
  db.prepare('INSERT INTO journal VALUES (?,?)').run('checkpoint', JSON.stringify(f.checkpoint));
  db.close();
  db = new DatabaseSync(dbFile);
  const value = (name: string): string =>
    (db.prepare('SELECT value FROM journal WHERE name=?').get(name) as { value: string }).value;
  const restored = { worker: JSON.parse(value('worker')) as FencedWorkerJournalSnapshot,
    checkpoint: JSON.parse(value('checkpoint')) as TransferCheckpoint,
    route: f.route };
  db.close();

  let brokerEpoch = 5;
  let grantEpoch = 71;
  let readCalls = 0;
  const changes: Partial<InspectInput> = {
    sessionWitness: { currentEpoch: async () => brokerEpoch },
    authorize: async () => grantEpoch === 71,
    stageReadback: { inspect: async (w, p) => {
      readCalls++;
      return { kind: 'verified' as const, deviceId: w.targetDeviceId,
        offset: p.offset, length: p.length, sha256: p.sha256 };
    } },
  };
  const first = await inspect(restored, changes);
  assert.equal(first.state, 'readback_verified_not_committed');
  assert.equal(first.checkpointAdvanced, false);
  assert.equal(readCalls, 1);
  assert.equal(restored.checkpoint.offset, 0);

  brokerEpoch = 6;
  assert.equal((await inspect(restored, changes)).state, 'epoch_stale');
  grantEpoch = 72;
  brokerEpoch = 5;
  assert.equal((await inspect(restored, changes)).state, 'authority_blocked');
  assert.equal(restored.checkpoint.pending?.requestId, f.worker.pending?.requestId);
  assert.equal(restored.checkpoint.offset, 0);
});

test('Promise-gated reconnect and owner revoke while readback in flight never settle old ACK', async () => {
  const f = fixture(true);
  let entered!: () => void;
  let release!: () => void;
  const onRead = new Promise<void>(r => { entered = r; });
  const resume = new Promise<void>(r => { release = r; });
  let activeEpoch = 5;
  let ownerGrantEpoch = 71;
  const pending = inspect(f, {
    authorize: async () => ownerGrantEpoch === 71,
    sessionWitness: { currentEpoch: async () => activeEpoch },
    stageReadback: { inspect: async (w, p) => {
      entered();
      await resume;
      return { kind: 'verified' as const, deviceId: w.targetDeviceId,
        offset: p.offset, length: p.length, sha256: p.sha256 };
    } },
  });
  await onRead; // deterministic pre-readback completion barrier; no sleeps
  activeEpoch = 6;
  ownerGrantEpoch = 72;
  release();
  const result = await pending;
  assert.equal(result.state, 'authority_blocked');
  assert.equal(result.automaticallyReplayable, false);
  assert.equal(f.checkpoint.offset, 0);
  assert.equal(f.worker.bytesConfirmed, 0);
});

test('cancel with dispatched Native mutation retains UNKNOWN despite misleading CANCELLED state', async () => {
  const f = fixture(true);
  const oldId = f.worker.pending!.requestId;
  f.worker.state = 'CANCELLED';
  const output = await inspect(f);
  assert.equal(output.state, 'cancel_pending');
  assert.equal(output.automaticallyReplayable, false);
  assert.equal(output.externalSideEffectProven, false);
  assert.equal(f.worker.pending?.requestId, oldId);
  assert.equal(f.checkpoint.offset, 0);
});

test('malformed or forged lease/pending dispatched metadata fails closed', async () => {
  const f = fixture(true);
  const pending = f.worker.pending!;
  const badWorker: FencedWorkerJournalSnapshot = {
    ...f.worker, pending: { ...pending, dispatched: 'yes' as unknown as boolean },
  };
  assert.equal((await inspect(f, {worker: badWorker})).state, 'journal_mismatch');
  const invalidFence: FencedWorkerJournalSnapshot = {
    ...f.worker, fencing: {epoch:27, token:42 as unknown as string},
  };
  assert.equal((await inspect(f, {worker: invalidFence})).state, 'authority_blocked');
});
