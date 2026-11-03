import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CrossDeviceTransferJobs, type TransferJob, type TransferRemote }
  from '../src/mcp/cross-device-transfer-jobs.js';
import { type TrustedTransferAuthority, type TrustedTransferCoreGrants }
  from '../src/workspace/artifact-job-trust.js';

// Worker #21 follow-up to #640. All remote writes are in-memory; the only
// filesystem mutations are isolated, generated journal fixtures under TEMP.
// No physical Agent, external CAS, Windows service, user files, or VM.
const CHUNK = 65_536;
const source = Buffer.alloc(CHUNK + 71);
for (let n = 0; n < source.length; n++) source[n] = (n * 31 + 17) & 255;
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const owner = {
  accountId: 'account:qa21-only', projectId: 'Nexowire',
  sourceDeviceId: 'qa21-source', targetDeviceId: 'qa21-target',
  sourcePath: '/synthetic/qa21-source', targetPath: '/synthetic/qa21-target',
};

function handshake() {
  let entered!: () => void;
  let proceed!: () => void;
  let held = false;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { proceed = resolve; });
  return {
    reached,
    release: () => proceed(),
    hold: async () => {
      assert.equal(held, false, 'each fixture gate may be entered only once');
      held = true;
      entered();
      await released;
    },
  };
}

type Scenario = 'before-second-read' | 'forged-ack' | 'first-source-read';

function rig(root: string, scenario: Scenario) {
  const gate = handshake();
  const token = 'ONLY-IN-MEMORY-SYNTHETIC-EPOCH-NOT-TRUSTED-PRODUCTION';
  let stage = Buffer.alloc(0);
  let writes = 0;
  let publishes = 0;
  let sourceReads = 0;
  let secondSourceReads = 0;
  let readbacks = 0;
  const authority: TrustedTransferAuthority = {
    acquire: async () => ({ epoch: 1, token }),
    assertCurrent: async (_job, proof, phase, offset) => {
      assert.equal(proof.epoch, 1);
      assert.equal(proof.token, token);
      if (scenario === 'before-second-read' && phase === 'WRITE' &&
          offset === CHUNK) {
        // run(): after the first chunk was independently read back and its
        // journal offset committed, but BEFORE issuing source read #2.
        await gate.hold();
      }
    },
  };
  const grants: TrustedTransferCoreGrants = {
    assertCurrent: async job => {
      assert.equal(job.accountId, owner.accountId);
      assert.equal(job.projectId, owner.projectId);
      assert.equal(job.sourceDeviceId, owner.sourceDeviceId);
      assert.equal(job.targetDeviceId, owner.targetDeviceId);
    },
  };
  const remote: TransferRemote = {
    stat: async device => ({ type: 'file',
      size: device === owner.sourceDeviceId ? source.length : stage.length }),
    hash: async device => sha256(device === owner.sourceDeviceId ? source : stage),
    read: async (device, _file, offset, size) => {
      if (device === owner.sourceDeviceId) {
        sourceReads++;
        if (offset === CHUNK) secondSourceReads++;
        if (scenario === 'first-source-read' && offset === 0) await gate.hold();
      } else {
        readbacks++;
      }
      const value = device === owner.sourceDeviceId ? source : stage;
      const chunk = value.subarray(offset, offset + size);
      return {
        sourceBytes: value.length, offsetBytes: offset, bytesRead: chunk.length,
        contentBase64: chunk.toString('base64'),
      };
    },
    write: async () => { throw Error('NEVER_CALL_UNFENCED_WRITE'); },
    moveNoOverwrite: async () => { throw Error('NEVER_CALL_UNFENCED_PUBLISH'); },
    writeFenced: async (_job, env, body, first) => {
      const chunk = Buffer.from(body, 'base64');
      assert.equal(env.epoch, 1);
      assert.equal(env.offset, stage.length, 'synthetic exact-offset CAS');
      assert.equal(env.length, chunk.length);
      assert.equal(env.sha256, sha256(chunk));
      assert.equal(first, stage.length === 0);
      stage = Buffer.concat([stage, chunk]); // deliberately real fixture side effect
      writes++;
      if (scenario === 'forged-ack') {
        await gate.hold(); // effect occurred; ACK not delivered yet
        return {
          requestId: randomUUID(), // wrong request ID with otherwise valid receipt
          epoch: env.epoch, offset: env.offset, length: env.length, sha256: env.sha256,
        };
      }
      return {
        requestId: env.requestId, epoch: env.epoch, offset: env.offset,
        length: env.length, sha256: env.sha256,
      };
    },
    publishFenced: async () => {
      publishes++;
      throw Error('PUBLISH_MUST_NOT_BE_DISPATCHED');
    },
  };
  const jobs = new CrossDeviceTransferJobs(root, remote,
    { requireExternalAuthority: true, authority, grants });
  const status = (id: string) => jobs.status(id,
    owner.accountId, owner.sourceDeviceId, owner.targetDeviceId);
  const cancel = (id: string) => jobs.cancel(id,
    owner.accountId, owner.sourceDeviceId, owner.targetDeviceId);
  return {
    gate, jobs, status, cancel,
    get writes() { return writes; },
    get publishes() { return publishes; },
    get stage() { return stage; },
    get sourceReads() { return sourceReads; },
    get secondSourceReads() { return secondSourceReads; },
    get readbacks() { return readbacks; },
  };
}

async function isolated(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-21-followup-'));
  try { await run(root); }
  finally { await fs.rm(root, { force: true, recursive: true }); }
}

async function journal(root: string, id: string): Promise<TransferJob> {
  return JSON.parse(await fs.readFile(path.join(root, id + '.json'), 'utf8')) as TransferJob;
}

test('#588 cancel after first VERIFIED chunk before next source read: no extra read/write',
  { timeout: 15000 }, async () => isolated(async root => {
    const fx = rig(root, 'before-second-read');
    const started = await fx.jobs.start(owner);
    try {
      await fx.gate.reached; // pre-second-read authority gate is actually held
      const before = await journal(root, started.id);
      assert.equal(before.state, 'RUNNING');
      assert.equal(before.bytesConfirmed, CHUNK);
      assert.equal(before.pending, undefined);
      assert.equal(fx.sourceReads, 1);
      assert.equal(fx.secondSourceReads, 0);
      assert.equal(fx.readbacks, 1, 'first chunk independently read back');
      assert.equal(fx.writes, 1);
      assert.equal(fx.stage.length, CHUNK);
      const cancelled = await fx.cancel(started.id);
      assert.equal(cancelled.state, 'CANCEL_REQUESTED');
      const statuses = await Promise.all(Array.from({ length: 12 },
        () => fx.status(started.id)));
      for (const response of statuses) {
        assert.equal(response.state, 'CANCEL_REQUESTED');
        assert.equal(response.bytesConfirmed, CHUNK);
      }
    } finally {
      fx.gate.release();
      await fx.jobs.waitForIdle(started.id);
    }
    const after = await journal(root, started.id);
    // A confirmed first stage write is already a remote side effect. It must
    // stay quarantined/unknown, but the cancelled next chunk may not be read.
    assert.equal(after.state, 'MUTATION_UNKNOWN');
    assert.equal(after.bytesConfirmed, CHUNK);
    assert.equal(after.pending, undefined);
    assert.equal(fx.secondSourceReads, 0,
      'post-cancel loop must not issue source read #2');
    assert.equal(fx.writes, 1);
    assert.equal(fx.publishes, 0);
    assert.equal(fx.stage.length, CHUNK);
  }));

test('#588 wrong requestId ACK after Native effect: concurrent status never credits it; cancel stays UNKNOWN',
  { timeout: 15000 }, async () => isolated(async root => {
    const fx = rig(root, 'forged-ack');
    const started = await fx.jobs.start(owner);
    let pendingId = '';
    try {
      await fx.gate.reached; // one write side effect, ACK still withheld
      assert.equal(fx.writes, 1);
      assert.equal(fx.stage.length, CHUNK);
      const before = await journal(root, started.id);
      assert.equal(before.state, 'RUNNING');
      assert.equal(before.bytesConfirmed, 0);
      assert.equal(before.pending?.length, CHUNK);
      assert.equal(before.pending?.offset, 0);
      pendingId = before.pending!.requestId;
      const statuses = await Promise.all(Array.from({ length: 24 },
        () => fx.status(started.id)));
      for (const response of statuses) {
        assert.equal(response.bytesConfirmed, 0);
        assert.equal(response.state, 'RUNNING');
      }
      assert.equal((await fx.cancel(started.id)).state, 'CANCEL_REQUESTED');
      const afterCancel = await Promise.all(Array.from({ length: 8 },
        () => fx.status(started.id)));
      for (const response of afterCancel) {
        assert.equal(response.state, 'CANCEL_REQUESTED');
        assert.equal(response.bytesConfirmed, 0);
      }
    } finally {
      fx.gate.release(); // now deliver a forged requestId receipt
      await fx.jobs.waitForIdle(started.id);
    }
    const after = await journal(root, started.id);
    assert.equal(after.state, 'MUTATION_UNKNOWN');
    assert.equal(after.errorCode, 'FORGED_WRITE_RECEIPT');
    assert.equal(after.pending?.requestId, pendingId);
    assert.equal(after.bytesConfirmed, 0);
    assert.equal(fx.writes, 1);
    assert.equal(fx.publishes, 0);
    // Crucial post-worker regression: cancellation cannot convert a real
    // staged write with a mismatched receipt into a "clean cancellation".
    const cancelledAgain = await fx.cancel(started.id);
    assert.equal(cancelledAgain.state, 'MUTATION_UNKNOWN');
    const final = await journal(root, started.id);
    assert.equal(final.pending?.requestId, pendingId);
    assert.equal(final.bytesConfirmed, 0);
    assert.equal(fx.writes, 1, 'no replay of an unknown write');
  }));

test('#588 concurrent status/cancel during first in-flight source read preserves zero-write CANCELLED',
  { timeout: 15000 }, async () => isolated(async root => {
    const fx = rig(root, 'first-source-read');
    const started = await fx.jobs.start(owner);
    try {
      await fx.gate.reached; // first source read is truly in flight
      const observed = await Promise.all([
        fx.cancel(started.id),
        ...Array.from({ length: 32 }, () => fx.status(started.id)),
      ]);
      assert.equal(observed[0]?.state, 'CANCEL_REQUESTED');
      for (const entry of observed) {
        assert.ok(entry?.state === 'RUNNING' || entry?.state === 'CANCEL_REQUESTED',
          'no status may advertise a fabricated terminal result');
        assert.equal(entry?.bytesConfirmed, 0);
      }
      const again = await Promise.all(Array.from({ length: 16 },
        () => fx.status(started.id)));
      for (const entry of again) {
        assert.equal(entry.state, 'CANCEL_REQUESTED');
        assert.equal(entry.bytesConfirmed, 0);
      }
      assert.equal(fx.writes, 0);
    } finally {
      fx.gate.release();
      await fx.jobs.waitForIdle(started.id);
    }
    const final = await journal(root, started.id);
    assert.equal(final.state, 'CANCELLED',
      'read-only in-flight operation with zero Native writes must cancel cleanly');
    assert.equal(final.bytesConfirmed, 0);
    assert.equal(final.pending, undefined);
    assert.equal(fx.writes, 0);
    assert.equal(fx.publishes, 0);
  }));
