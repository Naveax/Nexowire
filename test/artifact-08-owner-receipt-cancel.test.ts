import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CrossDeviceTransferJobs, type TransferJob, type TransferRemote }
  from '../src/mcp/cross-device-transfer-jobs.js';
import { TransferTrustError, type TrustedTransferAuthority }
  from '../src/workspace/artifact-job-trust.js';

// Production owner regression: child #651/#677/#682 tests are never modified
// or copied into this owner PR. Synthetic-only, no live Agent or external CAS.
const input = {
  accountId: 'account:qa08-owner', projectId: 'Nexowire',
  sourceDeviceId: 'fixture-source', targetDeviceId: 'fixture-target',
  sourcePath: '/fixture/source', targetPath: '/fixture/target',
};
const CHUNK = 65536;
const content = Buffer.alloc(CHUNK + 101, 0x5a);
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function fixture(fn: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-08-owner-ack-'));
  try { await fn(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const readState = async (root: string, id: string): Promise<TransferJob> =>
  JSON.parse(await fs.readFile(path.join(root, id + '.json'), 'utf8')) as TransferJob;

function setup(mode: 'forged-after-cancel' | 'publish-refused' | 'cancel-next-source') {
  let stage = Buffer.alloc(0), writes = 0, publishes = 0, secondSourceReads = 0;
  let hitGate!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { hitGate = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let gated = false;
  const authority: TrustedTransferAuthority = {
    acquire: async () => ({ epoch: 1, token: 'SYNTHETIC-ONLY-EPOCH-TOKEN-00000000000001' }),
    assertCurrent: async (_job, _lease, phase, offset) => {
      if (mode === 'cancel-next-source' && phase === 'WRITE' &&
          offset === CHUNK && !gated) {
        gated = true; hitGate(); await released;
      }
    },
  };
  const remote: TransferRemote = {
    stat: async device => ({type: 'file', size: device === input.sourceDeviceId
      ? content.length : stage.length}),
    hash: async device => digest(device === input.sourceDeviceId ? content : stage),
    read: async (device, _file, offset, count) => {
      if (device === input.sourceDeviceId && offset === CHUNK) secondSourceReads++;
      const all = device === input.sourceDeviceId ? content : stage;
      const piece = all.subarray(offset, offset + count);
      return { sourceBytes: all.length, offsetBytes: offset,
        bytesRead: piece.length, contentBase64: piece.toString('base64') };
    },
    write: async () => { throw Error('UNFENCED_WRITE_FORBIDDEN'); },
    moveNoOverwrite: async () => { throw Error('UNFENCED_PUBLISH_FORBIDDEN'); },
    writeFenced: async (_job, env, raw, first) => {
      const piece = Buffer.from(raw, 'base64');
      assert.equal(env.offset, stage.length);
      assert.equal(first, stage.length === 0);
      assert.equal(env.length, piece.length);
      assert.equal(env.sha256, digest(piece));
      stage = Buffer.concat([stage, piece]);
      writes++;
      if (mode === 'forged-after-cancel') {
        hitGate(); await released;
        return {requestId: randomUUID(), epoch: env.epoch, offset: env.offset,
          length: env.length, sha256: env.sha256};
      }
      return {requestId: env.requestId, epoch: env.epoch, offset: env.offset,
        length: env.length, sha256: env.sha256};
    },
    publishFenced: async () => {
      publishes++;
      throw new TransferTrustError('CORE_GRANT_EPOCH_STALE',
        'Synthetic CORE owner changed during Native publication');
    },
  };
  return {authority, remote, entered, release: () => release(),
    get writes() { return writes; }, get publishes() { return publishes; },
    get secondSourceReads() { return secondSourceReads; },
    get stage() { return stage; }};
}
const grants = {assertCurrent: async () => undefined};

test('dispatched forged ACK + cancellation preserves exact receipt error and pending across Hub reopen',
  {timeout:15000}, async () => fixture(async root => {
    const fx = setup('forged-after-cancel');
    const owner = new CrossDeviceTransferJobs(root, fx.remote,
      {requireExternalAuthority:true,authority:fx.authority,grants});
    const job = await owner.start(input);
    let receiptId: string|undefined;
    try {
      await fx.entered;
      const prior = await readState(root,job.id);
      receiptId = prior.pending?.requestId;
      assert.equal(prior.pending?.dispatched,true);
      assert.equal(prior.bytesConfirmed,0);
      assert.equal((await owner.cancel(job.id,input.accountId,input.sourceDeviceId,
        input.targetDeviceId)).state,'CANCEL_REQUESTED');
    } finally { fx.release(); await owner.waitForIdle(job.id); }
    const actual = await readState(root,job.id);
    assert.equal(actual.state,'MUTATION_UNKNOWN');
    assert.equal(actual.errorCode,'FORGED_WRITE_RECEIPT');
    assert.equal(actual.pending?.requestId,receiptId);
    assert.equal(actual.bytesConfirmed,0);
    const otherHub = new CrossDeviceTransferJobs(root,fx.remote,
      {requireExternalAuthority:true,authority:fx.authority,grants});
    assert.equal((await otherHub.cancel(job.id,input.accountId,input.sourceDeviceId,
      input.targetDeviceId)).state,'MUTATION_UNKNOWN');
    assert.equal((await readState(root,job.id)).errorCode,'FORGED_WRITE_RECEIPT');
    assert.equal(fx.writes,1);
    assert.equal(fx.publishes,0);
  }));

test('rejected Native publish retains exact CORE epoch denial, UNKNOWN after later cancel',
  {timeout:15000}, async () => fixture(async root => {
    const fx=setup('publish-refused');
    const jobs = new CrossDeviceTransferJobs(root,fx.remote,
      {requireExternalAuthority:true,authority:fx.authority,grants});
    const job=await jobs.start(input);
    await jobs.waitForIdle(job.id);
    const before=await readState(root,job.id);
    assert.equal(before.state,'MUTATION_UNKNOWN');
    assert.equal(before.errorCode,'CORE_GRANT_EPOCH_STALE');
    assert.equal(before.bytesConfirmed,content.length);
    const b = new CrossDeviceTransferJobs(root,fx.remote,
      {requireExternalAuthority:true,authority:fx.authority,grants});
    assert.equal((await b.cancel(job.id,input.accountId,input.sourceDeviceId,
      input.targetDeviceId)).state,'MUTATION_UNKNOWN');
    assert.equal((await readState(root,job.id)).errorCode,'CORE_GRANT_EPOCH_STALE');
    assert.equal(fx.publishes,1);
  }));

test('post-first-chunk cancel gated before next read makes zero additional source reads',
  {timeout:15000}, async () => fixture(async root => {
    const fx=setup('cancel-next-source');
    const jobs = new CrossDeviceTransferJobs(root,fx.remote,
      {requireExternalAuthority:true,authority:fx.authority,grants});
    const job=await jobs.start(input);
    try {
      await fx.entered;
      const state=await readState(root,job.id);
      assert.equal(state.bytesConfirmed,CHUNK);
      assert.equal(state.pending,undefined);
      assert.equal((await jobs.cancel(job.id,input.accountId,
        input.sourceDeviceId,input.targetDeviceId)).state,'CANCEL_REQUESTED');
    } finally { fx.release(); await jobs.waitForIdle(job.id); }
    const after=await readState(root,job.id);
    assert.equal(after.state,'MUTATION_UNKNOWN');
    assert.equal(after.bytesConfirmed,CHUNK);
    assert.equal(fx.secondSourceReads,0);
    assert.equal(fx.writes,1);
    assert.equal(fx.publishes,0);
  }));
