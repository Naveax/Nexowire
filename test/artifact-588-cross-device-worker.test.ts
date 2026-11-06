import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CrossDeviceTransferJobs, TransferJobError, type TransferRemote
} from '../src/mcp/cross-device-transfer-jobs.js';

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const owner = 'account:fixture-owner', source = 'source-device', target = 'target-device';
const args = { accountId: owner, projectId: 'Nexowire', sourceDeviceId: source,
  sourcePath: '/src/payload.bin', targetDeviceId: target, targetPath: '/dst/payload.bin' };
function fake(bytes: Buffer, options: { failAfterFirstWrite?: boolean; slowReadMs?: number } = {}) {
  const files = new Map<string, Buffer>([[source + ':' + args.sourcePath, bytes]]);
  let failOnce = !!options.failAfterFirstWrite;
  const counters = { reads: 0, writes: 0, commits: 0 };
  const ops: TransferRemote = {
    stat: async (device, name) => {
      const data = files.get(device + ':' + name);
      if (!data) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { type: 'file', size: data.length, modifiedAt: 'immutable' };
    },
    hash: async (device, name) => {
      const data = files.get(device + ':' + name);
      if (!data) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return hash(data);
    },
    read: async (device, name, offset, max) => {
      assert.equal(device, source);
      if (options.slowReadMs) await new Promise(resolve => setTimeout(resolve, options.slowReadMs));
      const data = files.get(device + ':' + name)!;
      const chunk = data.subarray(offset, offset + max);
      counters.reads++;
      return { sourceBytes: data.length, offsetBytes: offset, bytesRead: chunk.length,
        contentBase64: chunk.toString('base64') };
    },
    write: async (device, name, encoded, first, offset) => {
      assert.equal(device, target);
      const key = device + ':' + name;
      const next = Buffer.from(encoded, 'base64');
      const current = files.get(key);
      if (first) {
        if (current) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        files.set(key, Buffer.from(next));
      } else {
        if (!current || offset !== current.length) throw Error('WRONG_OFFSET');
        files.set(key, Buffer.concat([current, next]));
      }
      counters.writes++;
      if (failOnce) { failOnce = false; throw Error('UNKNOWN_WRITE_ACK'); }
      return next.length;
    },
    moveNoOverwrite: async (device, from, to) => {
      const stage = files.get(device + ':' + from);
      if (!stage) throw Error('STAGE_MISSING');
      if (files.has(device + ':' + to)) throw Error('DESTINATION_EXISTS');
      files.set(device + ':' + to, stage);
      files.delete(device + ':' + from);
      counters.commits++;
    },
  };
  return { files, ops, counters };
}
async function fixture(fn: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-597-worker-'));
  try { await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function poll(jobs: CrossDeviceTransferJobs, id: string,
  expected: string[] = ['COMPLETED'], attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    const status = await jobs.status(id, owner, source, target);
    if (expected.includes(status.state)) return status;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const state = await jobs.status(id, owner, source, target); throw Error('transfer did not enter ' + expected.join('|') + '; actual=' + JSON.stringify(state));
}
test('one Hub start completes 221KiB binary cross-device transfer in 64KiB chunks', async () =>
  fixture(async root => {
    const payload = Buffer.alloc(221 * 1024);
    for(let i=0;i<payload.length;i++) payload[i] = i % 239;
    const remote = fake(payload);
    const jobs = new CrossDeviceTransferJobs(root, remote.ops);
    const initial = await jobs.start({ ...args, expectedSourceSha256: hash(payload) });
    assert.ok(initial.id);
    assert.equal(JSON.stringify(initial).includes('contentBase64'), false);
    const done = await poll(jobs, initial.id);
    await jobs.waitForIdle(initial.id);
    assert.equal(done.state, 'COMPLETED');
    assert.equal(done.bytesConfirmed, payload.length);
    assert.equal(done.sha256, hash(payload));
    assert.deepEqual(remote.files.get(target + ':' + args.targetPath), payload);
    assert.equal(remote.counters.writes, 4);
    assert.equal(remote.counters.commits, 1);
  }));
test('unknown write ACK is not blindly replayed; explicit new Hub instance reconciles exact prefix', async () =>
  fixture(async root => {
    const bytes = Buffer.alloc(4 * 65536 + 51, 67);
    const remote = fake(bytes, { failAfterFirstWrite: true });
    const first = new CrossDeviceTransferJobs(root, remote.ops);
    const job = await first.start(args);
    const lost = await poll(first, job.id, ['MUTATION_UNKNOWN']);
    await first.waitForIdle(job.id);
    assert.equal(lost.bytesConfirmed, 0);
    assert.equal(remote.counters.writes, 1);
    const restarted = new CrossDeviceTransferJobs(root, remote.ops);
    const next = await restarted.start({ ...args, resumeTransferId: job.id });
    assert.equal(next.bytesConfirmed, 65536);
    const done = await poll(restarted, job.id);
    await restarted.waitForIdle(job.id);
    assert.equal(done.state, 'COMPLETED');
    assert.deepEqual(remote.files.get(target + ':' + args.targetPath), bytes);
    assert.equal(remote.counters.writes, 5);
    assert.equal(remote.counters.commits, 1);
  }));
test('scope prevents foreign account/status/cancel and wrong resume project', async () =>
  fixture(async root => {
    const remote = fake(Buffer.alloc(120_000, 5), { slowReadMs: 70 });
    const jobs = new CrossDeviceTransferJobs(root, remote.ops);
    const started = await jobs.start(args);
    await assert.rejects(jobs.status(started.id, 'foreign', source, target),
      (e: unknown) => e instanceof TransferJobError && e.code === 'TRANSFER_SCOPE_DENIED');
    await assert.rejects(jobs.cancel(started.id, owner, source, 'foreign-device'),
      (e: unknown) => e instanceof TransferJobError && e.code === 'TRANSFER_SCOPE_DENIED');
    await assert.rejects(jobs.start({ ...args, projectId: 'other', resumeTransferId: started.id }),
      (e: unknown) => e instanceof TransferJobError && e.code === 'TRANSFER_SCOPE_DENIED');
    await jobs.cancel(started.id, owner, source, target);
    const ended = await poll(jobs, started.id, ['CANCELLED']);
    await jobs.waitForIdle(started.id);
    assert.equal(ended.state, 'CANCELLED');
    assert.equal(remote.files.has(target + ':' + args.targetPath), false);
  }));
test('atomic destination publication never replaces preexisting synthetic output', async () =>
  fixture(async root => {
    const bytes = Buffer.alloc(90_000, 74);
    const remote = fake(bytes);
    const prior = Buffer.from('prior destination');
    remote.files.set(target + ':' + args.targetPath, prior);
    const jobs = new CrossDeviceTransferJobs(root, remote.ops);
    const started = await jobs.start(args);
    const failed = await poll(jobs, started.id, ['MUTATION_UNKNOWN']);
    await jobs.waitForIdle(started.id);
    assert.equal(failed.state, 'MUTATION_UNKNOWN');
    assert.deepEqual(remote.files.get(target + ':' + args.targetPath), prior);
    assert.equal(remote.counters.commits, 0);
  }));


test('a second MCP session can cancel the real owner worker without overwriting its progress', async () =>
  fixture(async root => {
    const remote = fake(Buffer.alloc(7 * 65536, 51), { slowReadMs: 95 });
    const workerSession = new CrossDeviceTransferJobs(root, remote.ops);
    const otherSession = new CrossDeviceTransferJobs(root, remote.ops);
    const started = await workerSession.start(args);
    const before = await otherSession.status(started.id, owner, source, target);
    assert.ok(['RUNNING','QUEUED'].includes(before.state));
    await otherSession.cancel(started.id, owner, source, target);
    const ended = await poll(workerSession, started.id, ['CANCELLED']);
    await workerSession.waitForIdle(started.id);
    assert.equal(ended.state, 'CANCELLED');
    assert.equal(remote.files.has(target + ':' + args.targetPath), false);
    assert.equal(remote.counters.commits, 0);
  }));
test('source replacement in the middle of a bounded transfer fails closed', async () =>
  fixture(async root => {
    const bytes = Buffer.alloc(3 * 65536 + 11, 18);
    const remote = fake(bytes);
    const initialWrite = remote.ops.write;
    let changed = false;
    remote.ops.write = async (...parameters) => {
      const acknowledged = await initialWrite(...parameters);
      if (!changed) {
        changed = true;
        remote.files.set(source + ':' + args.sourcePath, Buffer.alloc(bytes.length, 99));
      }
      return acknowledged;
    };
    const jobs = new CrossDeviceTransferJobs(root, remote.ops);
    const started = await jobs.start(args);
    const finished = await poll(jobs, started.id, ['FAILED']);
    await jobs.waitForIdle(started.id);
    assert.equal(finished.errorCode, 'TRANSFER_SOURCE_CHANGED');
    assert.equal(remote.files.has(target + ':' + args.targetPath), false);
  }));
test('another Hub instance cannot resume an active owner lease and duplicate staged writes', async () =>
  fixture(async root => {
    const remote = fake(Buffer.alloc(4 * 65536, 61), { slowReadMs: 80 });
    const a = new CrossDeviceTransferJobs(root, remote.ops);
    const b = new CrossDeviceTransferJobs(root, remote.ops);
    const started = await a.start(args);
    // Wait until native staging begins so the durable worker lease exists.
    for (let i=0; i<60 && remote.counters.reads===0; i++)
      await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(remote.counters.reads > 0);
    await assert.rejects(b.start({ ...args, resumeTransferId: started.id }),
      (e: unknown) => e instanceof TransferJobError && e.code === 'TRANSFER_WORKER_BUSY');
    const done = await poll(a, started.id);
    await a.waitForIdle(started.id);
    assert.equal(done.state, 'COMPLETED');
    assert.equal(remote.counters.writes, 4);
  }));


test('explicit resume refuses a same-sized but tampered partially staged object', async () =>
  fixture(async root => {
    const bytes = Buffer.alloc(2 * 65536 + 101, 32);
    const remote = fake(bytes, { failAfterFirstWrite: true });
    const a = new CrossDeviceTransferJobs(root, remote.ops);
    const started = await a.start(args);
    await poll(a, started.id, ['MUTATION_UNKNOWN']);
    await a.waitForIdle(started.id);
    const stage = [...remote.files.keys()].find(name =>
      name.startsWith(target + ':' + args.targetPath + '.nexowire-upload-'));
    assert.ok(stage);
    const corrupt = Buffer.from(remote.files.get(stage)!);
    corrupt[100] = corrupt[100]! ^ 0xff;
    remote.files.set(stage, corrupt);
    const b = new CrossDeviceTransferJobs(root, remote.ops);
    await assert.rejects(b.start({ ...args, resumeTransferId: started.id }),
      (e: unknown) => e instanceof TransferJobError && e.code === 'TRANSFER_STAGE_CHANGED');
    assert.equal(remote.files.has(target + ':' + args.targetPath), false);
  }));
