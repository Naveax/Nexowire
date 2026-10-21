import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket, { WebSocketServer } from 'ws';
import {
  DurableTransferContinuity,
  TransferContinuityError,
  type AuthenticatedTransferRoute,
  type TransferBinding,
  type TransferCheckpoint,
  type TransferCheckpointStore,
  type DestinationReadback,
} from '../src/mcp/cross-device-transfer-continuity.js';

const jobId = randomUUID();
const owner = 'staging-owner-06';
const sourceDevice = 'synthetic-workpc';
const destinationDevice = 'synthetic-naveax';
const file = Buffer.alloc(221 * 1024 + 17, 0x5b);
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const binding: TransferBinding = {
  jobId, ownerId: owner, sourceDeviceId: sourceDevice,
  destinationDeviceId: destinationDevice,
  sourceSha256: hash(file), totalBytes: file.length,
};
const route = (epoch: number): AuthenticatedTransferRoute => ({
  ownerId: owner, sourceDeviceId: sourceDevice,
  destinationDeviceId: destinationDevice, epoch,
});

class SQLiteTransferJournal implements TransferCheckpointStore {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS connection_transfer_checkpoint(job TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL)');
  }
  async insert(row: TransferCheckpoint): Promise<boolean> {
    try {
      const r = this.db.prepare('INSERT OR IGNORE INTO connection_transfer_checkpoint(job,revision,value) VALUES(?,?,?)')
        .run(row.binding.jobId, row.revision, JSON.stringify(row));
      return r.changes === 1;
    } catch { return false; }
  }
  async read(id: string): Promise<TransferCheckpoint | undefined> {
    const r = this.db.prepare('SELECT value FROM connection_transfer_checkpoint WHERE job=?').get(id) as { value: string } | undefined;
    return r ? JSON.parse(r.value) as TransferCheckpoint : undefined;
  }
  async compareAndSwap(id: string, revision: number, row: TransferCheckpoint): Promise<boolean> {
    const r = this.db.prepare('UPDATE connection_transfer_checkpoint SET revision=?, value=? WHERE job=? AND revision=?')
      .run(row.revision, JSON.stringify(row), id, revision);
    return r.changes === 1;
  }
  close(): void { this.db.close(); }
}

async function fixture(t: import('node:test').TestContext, reader: DestinationReadback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nw-durable-connection-06-'));
  const filename = path.join(dir, 'journal.sqlite');
  const journals: SQLiteTransferJournal[] = [];
  const open = () => {
    const instance = new SQLiteTransferJournal(filename);
    journals.push(instance);
    return instance;
  };
  t.after(async () => {
    for (const j of journals) j.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { open, controller: new DurableTransferContinuity(open(), reader) };
}
const matched = (b: TransferBinding, p: { offset: number; length: number; sha256: string }) => ({
  kind: 'verified' as const, deviceId: b.destinationDeviceId,
  offset: p.offset, length: p.length, sha256: p.sha256,
});
const chunkHash = hash(file.subarray(0, 65_536));
const noReadback: DestinationReadback = async () => ({ kind: 'unavailable' });

test('durable checkpoint survives opener restart; unknown mutation is never replayed; independently verified prefix advances', async t => {
  const independentlyStagedPrefix = Buffer.from(file.subarray(0, 65_536));
  const f = await fixture(t, async (b, p) => ({
    kind: 'verified', deviceId: b.destinationDeviceId, offset: p.offset,
    length: independentlyStagedPrefix.length, sha256: hash(independentlyStagedPrefix),
  }));
  const c = f.controller;
  await c.create(binding, route(1));
  const pending = await c.reserveWrite({ jobId, route: route(1), offset: 0, length: 65_536, sha256: chunkHash });
  const req = pending.pending!.requestId;
  assert.equal(pending.status, 'awaiting_ack');
  await assert.rejects(c.reserveWrite({ jobId, route: route(1), offset: 0, length: 65_536, sha256: chunkHash }), {
    code: 'TRANSFER_NOT_DISPATCHABLE',
  });
  const afterDrop = await c.onReconnect({ jobId, oldRoute: route(1), nextEpoch: 2 });
  assert.equal(afterDrop.status, 'unknown');
  const reattached = new DurableTransferContinuity(f.open(), async (b, p) => ({
    kind: 'verified', deviceId: b.destinationDeviceId, offset: p.offset,
    length: independentlyStagedPrefix.length, sha256: hash(independentlyStagedPrefix),
  }));
  assert.equal((await reattached.inspect(jobId, route(2))).status, 'unknown');
  await assert.rejects(reattached.reserveWrite({ jobId, route: route(2), offset: 0, length: 65_536, sha256: chunkHash }), {
    code: 'TRANSFER_NOT_DISPATCHABLE',
  });
  const reconciled = await reattached.reconcilePending(jobId, route(2));
  assert.equal(reconciled.offset, 65_536);
  assert.equal(reconciled.pending, undefined);
  assert.equal(reconciled.status, 'ready');
  const secondChunk = await reattached.reserveWrite({
    jobId, route: route(2), offset: 65_536, length: 65_536,
    sha256: hash(file.subarray(65_536, 131_072)),
  });
  assert.notEqual(secondChunk.pending?.requestId, req);
  assert.equal(secondChunk.pending?.offset, 65_536);
});

test('stale ACK, mismatched request UUID and wrong owner/device cannot settle a pending write', async t => {
  const f = await fixture(t, noReadback);
  await f.controller.create(binding, route(1));
  const reservation = await f.controller.reserveWrite({
    jobId, route: route(1), offset: 0, length: 65_536, sha256: chunkHash,
  });
  const req = reservation.pending!.requestId;
  assert.equal(await f.controller.observeAck({
    jobId, route: route(1), requestId: randomUUID(), offset: 0, sha256: chunkHash,
  }), false);
  assert.equal(await f.controller.observeAck({
    jobId, route: route(1), requestId: req, offset: 0, sha256: 'a'.repeat(64),
  }), false);
  await assert.rejects(f.controller.observeAck({
    jobId, route: { ...route(1), ownerId: 'other-owner' }, requestId: req,
    offset: 0, sha256: chunkHash,
  }), { code: 'TRANSFER_ROUTE_DENIED' });
  await assert.rejects(f.controller.observeAck({
    jobId, route: { ...route(1), destinationDeviceId: sourceDevice },
    requestId: req, offset: 0, sha256: chunkHash,
  }), { code: 'TRANSFER_ROUTE_DENIED' });
  assert.equal(await f.controller.observeAck({
    jobId, route: route(1), requestId: req, offset: 0, sha256: chunkHash,
  }), true);
  assert.equal((await f.controller.inspect(jobId, route(1))).offset, 0);
  await f.controller.onReconnect({ jobId, oldRoute: route(1), nextEpoch: 2 });
  await assert.rejects(f.controller.observeAck({
    jobId, route: route(1), requestId: req, offset: 0, sha256: chunkHash,
  }), { code: 'TRANSFER_EPOCH_STALE' });
  assert.equal(await f.controller.observeAck({
    jobId, route: route(2), requestId: req, offset: 0, sha256: chunkHash,
  }), false);
  assert.equal((await f.controller.inspect(jobId, route(2))).status, 'unknown');
  assert.equal(reservation.pending?.ackObserved, false);
});

test('partial chunk, wrong destination and invalid hash remain UNKNOWN without extra dispatch', async t => {
  let mode: 'partial' | 'wrong_device' | 'wrong_hash' = 'partial';
  const f = await fixture(t, async (b, p) => {
    if (mode === 'partial') return { kind: 'partial' };
    if (mode === 'wrong_device') return { ...matched(b, p), deviceId: 'other' };
    return { ...matched(b, p), sha256: 'f'.repeat(64) };
  });
  const c = f.controller;
  await c.create(binding, route(1));
  await c.reserveWrite({ jobId, route: route(1), offset: 0, length: 65_536, sha256: chunkHash });
  for (mode of ['partial', 'wrong_device', 'wrong_hash'] as const) {
    const row = await c.reconcilePending(jobId, route(1));
    assert.equal(row.status, 'unknown');
    assert.equal(row.offset, 0);
    await assert.rejects(c.reserveWrite({
      jobId, route: route(1), offset: 0, length: 65_536, sha256: chunkHash,
    }), { code: 'TRANSFER_NOT_DISPATCHABLE' });
  }
});

test('cancel with an UNKNOWN write is fail-closed; no cleanup, replay or late resume', async t => {
  const f = await fixture(t, async (b, p) => matched(b, p));
  await f.controller.create(binding, route(1));
  await f.controller.reserveWrite({ jobId, route: route(1), offset: 0, length: 65_536, sha256: chunkHash });
  await f.controller.onReconnect({ jobId, oldRoute: route(1), nextEpoch: 2 });
  const cancelled = await f.controller.cancel(jobId, route(2));
  assert.equal(cancelled.status, 'cancel_pending');
  assert.equal(cancelled.offset, 0);
  const replay = await f.controller.cancel(jobId, route(2));
  assert.equal(replay.revision, cancelled.revision);
  await assert.rejects(f.controller.reconcilePending(jobId, route(2)), {
    code: 'TRANSFER_NOT_RECONCILABLE',
  });
  await assert.rejects(f.controller.reserveWrite({
    jobId, route: route(2), offset: 0, length: 65_536, sha256: chunkHash,
  }), { code: 'TRANSFER_NOT_DISPATCHABLE' });
});

test('concurrent writes use durable revision CAS and no overlapping dispatch', async t => {
  const f = await fixture(t, noReadback);
  await f.controller.create(binding, route(1));
  const [a, b] = await Promise.allSettled([
    f.controller.reserveWrite({ jobId, route: route(1), offset: 0, length: 65_536, sha256: chunkHash }),
    new DurableTransferContinuity(f.open(), noReadback)
      .reserveWrite({ jobId, route: route(1), offset: 0, length: 65_536, sha256: chunkHash }),
  ]);
  assert.equal([a, b].filter(x => x.status === 'fulfilled').length, 1);
  const failed = [a, b].find(x => x.status === 'rejected');
  assert.ok(failed?.status === 'rejected');
  assert.ok(failed.reason instanceof TransferContinuityError);
  assert.ok(['TRANSFER_CAS_CONFLICT', 'TRANSFER_NOT_DISPATCHABLE'].includes(failed.reason.code));
});

test('source digest mismatch cannot finalize or publish an unverified result', async t => {
  const whole = Buffer.from([1, 2, 3]);
  const b: TransferBinding = { ...binding, jobId: randomUUID(), totalBytes: whole.length, sourceSha256: hash(whole) };
  const f = await fixture(t, async (bind, p) => matched(bind, p));
  let actualPublication = { kind: 'mismatch' as const } as
    | { kind: 'mismatch' } | { kind: 'verified'; deviceId: string; size: number; sha256: string };
  const c = new DurableTransferContinuity(f.open(), async (bind, p) => matched(bind, p),
    async () => actualPublication);
  await c.create(b, route(1));
  await c.reserveWrite({
    jobId: b.jobId, route: route(1), offset: 0, length: 3, sha256: hash(whole),
  });
  const matchedResult = await c.reconcilePending(b.jobId, route(1));
  assert.equal(matchedResult.status, 'verified');
  await assert.rejects(c.confirmPublished(b.jobId, route(1)),
    { code: 'TRANSFER_PUBLISH_UNVERIFIED' });
  assert.equal((await c.inspect(b.jobId, route(1))).status, 'verified');
  actualPublication = { kind: 'verified', deviceId: b.destinationDeviceId,
    size: b.totalBytes, sha256: 'a'.repeat(64) };
  await assert.rejects(c.confirmPublished(b.jobId, route(1)),
    { code: 'TRANSFER_PUBLISH_UNVERIFIED' });
  actualPublication = { kind: 'verified', deviceId: b.destinationDeviceId,
    size: b.totalBytes, sha256: hash(whole) };
  const result = await c.confirmPublished(b.jobId, route(1));
  assert.equal(result.status, 'complete');
});

test('ephemeral localhost WSS loss between write and ACK makes durable job UNKNOWN; stale ACK fenced after reconnect', async t => {
  const f = await fixture(t, noReadback);
  const c = f.controller;
  await c.create(binding, route(1));
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let sent = 0;
  wss.on('connection', client => {
    client.on('message', () => { sent++; client.terminate(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const ws = new WebSocket('ws://127.0.0.1:' + addr.port);
  ws.on('error', () => undefined);
  t.after(async () => {
    ws.terminate();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const pending = await c.reserveWrite({ jobId, route: route(1), offset: 0, length: 65_536, sha256: chunkHash });
  const responseLost = new Promise<void>(resolve => ws.once('close', () => resolve()));
  ws.send(JSON.stringify({ requestId: pending.pending?.requestId, epoch: 1 }));
  await responseLost;
  assert.equal(sent, 1);
  const unknown = await c.onReconnect({ jobId, oldRoute: route(1), nextEpoch: 2 });
  assert.equal(unknown.status, 'unknown');
  assert.equal(await c.observeAck({
    jobId, route: route(2), requestId: pending.pending!.requestId,
    offset: 0, sha256: chunkHash,
  }), false);
  assert.equal((await c.inspect(jobId, route(2))).offset, 0);
  await assert.rejects(c.reserveWrite({
    jobId, route: route(2), offset: 0, length: 65_536, sha256: chunkHash,
  }), { code: 'TRANSFER_NOT_DISPATCHABLE' });
});
