import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CrossDeviceTransferJobs, type TransferRemote, type TransferJob }
  from '../src/mcp/cross-device-transfer-jobs.js';
import { type TrustedTransferAuthority, type TrustedTransferCoreGrants }
  from '../src/workspace/artifact-job-trust.js';

/**
 * Worker #21: source-only, in-memory Remote/authority fixtures.
 * The gates are explicit Promise handshakes, not sleeps or a production CAS.
 * These tests NEVER connect to a real Agent, Hub, filesystem destination or VM.
 */
const CHUNK = 65_536;
const source = Buffer.alloc(CHUNK + 1, 0x4b);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const input = {
  accountId: 'account:synthetic-21-owner', projectId: 'Nexowire',
  sourceDeviceId: 'synthetic-21-source', targetDeviceId: 'synthetic-21-target',
  sourcePath: '/fixture/source.bin', targetPath: '/fixture/target.bin',
};
type HoldPoint = 'source-read' | 'after-native-side-effect' |
  'second-source-read' | 'target-readback';

function gate() {
  let notify!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { notify = resolve; });
  const unlocked = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  return {
    reached,
    release,
    pause: async () => {
      assert.equal(entered, false, 'fixture gate must be reached only once');
      entered = true;
      notify();
      await unlocked;
    },
  };
}

function fixture(root: string, holdPoint: HoldPoint) {
  const blocked = gate();
  let stage = Buffer.alloc(0);
  let writes = 0;
  let publishes = 0;
  const token = 'SYNTHETIC-ONLY-NOT-EXTERNAL-MONOTONIC-AUTHORITY';
  const authority: TrustedTransferAuthority = {
    acquire: async () => ({ epoch: 1, token }),
    assertCurrent: async (_job, proof) => {
      assert.equal(proof.epoch, 1);
      assert.equal(proof.token, token);
    },
  };
  const grants: TrustedTransferCoreGrants = {
    assertCurrent: async job => {
      assert.equal(job.accountId, input.accountId);
      assert.equal(job.projectId, input.projectId);
      assert.equal(job.sourceDeviceId, input.sourceDeviceId);
      assert.equal(job.targetDeviceId, input.targetDeviceId);
    },
  };
  const remote: TransferRemote = {
    stat: async device => ({
      type: 'file', size: device === input.sourceDeviceId ? source.length : stage.length,
    }),
    hash: async device => sha256(device === input.sourceDeviceId ? source : stage),
    read: async (device, _file, offset, size) => {
      if (device === input.sourceDeviceId &&
          ((holdPoint === 'source-read' && offset === 0) ||
           (holdPoint === 'second-source-read' && offset === CHUNK))) {
        await blocked.pause();
      }
      if (device === input.targetDeviceId && holdPoint === 'target-readback' &&
          offset === 0) await blocked.pause();
      const all = device === input.sourceDeviceId ? source : stage;
      const chunk = all.subarray(offset, offset + size);
      return { sourceBytes: all.length, offsetBytes: offset,
        bytesRead: chunk.length, contentBase64: chunk.toString('base64') };
    },
    write: async () => { throw Error('UNFENCED_WRITE_FORBIDDEN'); },
    moveNoOverwrite: async () => { throw Error('UNFENCED_PUBLISH_FORBIDDEN'); },
    writeFenced: async (_job, envelope, encoded, first) => {
      const chunk = Buffer.from(encoded, 'base64');
      assert.equal(envelope.epoch, 1);
      assert.equal(chunk.length, envelope.length);
      assert.equal(sha256(chunk), envelope.sha256);
      assert.equal(envelope.offset, stage.length, 'atomic synthetic offset CAS');
      assert.equal(first, stage.length === 0);
      stage = Buffer.concat([stage, chunk]);
      writes++;
      if (holdPoint === 'after-native-side-effect') {
        // Actual stage mutation has happened. The ACK outcome is deliberately
        // unknown to the Hub when the cancellation races with this Promise.
        await blocked.pause();
        throw Error('SYNTHETIC_ACK_LOST_AFTER_WRITE');
      }
      return { requestId: envelope.requestId, epoch: envelope.epoch,
        offset: envelope.offset, length: envelope.length, sha256: envelope.sha256 };
    },
    publishFenced: async () => { publishes++; throw Error('UNEXPECTED_PUBLISH'); },
  };
  const jobs = new CrossDeviceTransferJobs(root, remote,
    { requireExternalAuthority: true, authority, grants });
  return { jobs, blocked,
    get writes() { return writes; },
    get publishes() { return publishes; },
    get stage() { return stage; },
  };
}

async function isolated(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-21-cancel-race-'));
  try { await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function journal(root: string, id: string): Promise<TransferJob> {
  return JSON.parse(await fs.readFile(path.join(root, id + '.json'), 'utf8')) as TransferJob;
}

test('#588 cancel in a gated source read settles CANCELLED with ZERO dispatched writes',
  { timeout: 15000 }, async () => isolated(async root => {
    const fx = fixture(root, 'source-read');
    const started = await fx.jobs.start(input);
    try {
      await fx.blocked.reached; // proves read is in-flight, without a timeout sleep
      const requested = await fx.jobs.cancel(started.id,
        input.accountId, input.sourceDeviceId, input.targetDeviceId);
      assert.equal(requested.state, 'CANCEL_REQUESTED');
    } finally {
      fx.blocked.release();
      await fx.jobs.waitForIdle(started.id);
    }
    const final = await fx.jobs.status(started.id,
      input.accountId, input.sourceDeviceId, input.targetDeviceId);
    assert.equal(fx.writes, 0, 'read-only path must not dispatch a Native write');
    assert.equal(fx.publishes, 0);
    assert.equal(final.bytesConfirmed, 0);
    assert.equal(final.state, 'CANCELLED',
      'never-dispatched write must not become MUTATION_UNKNOWN');
    assert.equal((await journal(root, started.id)).pending, undefined);
  }));

test('#588 cancel after Native write applied but before ACK stays MUTATION_UNKNOWN',
  { timeout: 15000 }, async () => isolated(async root => {
    const fx = fixture(root, 'after-native-side-effect');
    const started = await fx.jobs.start(input);
    try {
      await fx.blocked.reached; // Native stage side effect already occurred
      assert.equal(fx.writes, 1);
      assert.equal(fx.stage.length, CHUNK);
      const requested = await fx.jobs.cancel(started.id,
        input.accountId, input.sourceDeviceId, input.targetDeviceId);
      assert.equal(requested.state, 'CANCEL_REQUESTED');
    } finally {
      fx.blocked.release();
      await fx.jobs.waitForIdle(started.id);
    }
    const final = await journal(root, started.id);
    assert.equal(final.state, 'MUTATION_UNKNOWN');
    assert.equal(final.bytesConfirmed, 0);
    assert.equal(final.pending?.offset, 0, 'do not erase the pre-dispatch journal');
    assert.equal(final.pending?.length, CHUNK);
    assert.equal(fx.writes, 1, 'never automatically replay an uncertain write');
    assert.equal(fx.publishes, 0);
  }));

test('#588 cancel after verified first chunk, while next source read is gated, is not no-side-effect CANCELLED',
  { timeout: 15000 }, async () => isolated(async root => {
    const fx = fixture(root, 'second-source-read');
    const started = await fx.jobs.start(input);
    try {
      await fx.blocked.reached; // first Native write AND readback finished
      const before = await journal(root, started.id);
      assert.equal(before.bytesConfirmed, CHUNK);
      assert.equal(fx.writes, 1);
      const requested = await fx.jobs.cancel(started.id,
        input.accountId, input.sourceDeviceId, input.targetDeviceId);
      assert.equal(requested.state, 'CANCEL_REQUESTED');
    } finally {
      fx.blocked.release();
      await fx.jobs.waitForIdle(started.id);
    }
    const final = await journal(root, started.id);
    assert.equal(final.state, 'MUTATION_UNKNOWN',
      'one previously committed remote chunk cannot be reported as side-effect-free cancellation');
    assert.equal(final.bytesConfirmed, CHUNK);
    assert.equal(fx.writes, 1);
    assert.equal(fx.publishes, 0);
  }));

test('#588 cancel during destination readback cannot erase dispatched Native mutation',
  { timeout: 15000 }, async () => isolated(async root => {
    const fx = fixture(root, 'target-readback');
    const started = await fx.jobs.start(input);
    try {
      await fx.blocked.reached; // Native write ACK received; readback not resolved
      assert.equal(fx.stage.length, CHUNK);
      assert.equal(fx.writes, 1);
      const requested = await fx.jobs.cancel(started.id,
        input.accountId, input.sourceDeviceId, input.targetDeviceId);
      assert.equal(requested.state, 'CANCEL_REQUESTED');
    } finally {
      fx.blocked.release();
      await fx.jobs.waitForIdle(started.id);
    }
    const final = await journal(root, started.id);
    assert.equal(final.state, 'MUTATION_UNKNOWN');
    assert.equal(final.bytesConfirmed, 0);
    assert.equal(final.pending?.length, CHUNK);
    assert.equal(fx.writes, 1);
    assert.equal(fx.publishes, 0);
  }));
