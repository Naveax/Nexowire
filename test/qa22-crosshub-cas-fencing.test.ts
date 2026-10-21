import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CrossDeviceTransferJobs, type TransferJob, type TransferRemote }
  from '../src/mcp/cross-device-transfer-jobs.js';
import { TransferTrustError, type TrustedTransferAuthority,
  type TrustedTransferCoreGrants, type FencedWriteEnvelope }
  from '../src/workspace/artifact-job-trust.js';

/** #22 test-only CAS/NATIVE emulator. NOT physical Agent 1.0.5 or rollback-external proof. */
const bytes = Buffer.alloc(2 * 65_536 + 19);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 23) % 251;
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const input = { accountId: 'fixture:qa22', projectId: 'Nexowire',
  sourceDeviceId: 'qa22-source', targetDeviceId: 'qa22-target',
  sourcePath: '/synthetic/qa22-source.bin', targetPath: '/synthetic/qa22-dest.bin' };
const notFound = () => Object.assign(Error('ENOENT'), { code: 'ENOENT' });
function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
async function expectGate(p: Promise<void>, label: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([p, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(Error('GATE_NOT_REACHED: ' + label)), 10_000);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
}
async function temp(fn: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-qa22-'));
  try { await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const stored = async (root: string, id: string): Promise<TransferJob> =>
  JSON.parse(await fs.readFile(path.join(root, id + '.json'), 'utf8')) as TransferJob;

/** One shared CAS for two separate Hub objects. No local JSON/PID is trusted. */
class Cas {
  readonly entries = new Map<string, { epoch: number; token: string; binding: string }>();
  private binding(job: Readonly<TransferJob>) {
    return [job.accountId, job.projectId, job.sourceDeviceId, job.targetDeviceId,
      job.sourcePath, job.targetPath].join('|');
  }
  readonly authority: TrustedTransferAuthority = {
    acquire: async (job, mode) => {
      const old = this.entries.get(job.id);
      if (old && old.binding !== this.binding(job))
        throw new TransferTrustError('CAS_SCOPE_CHANGED', 'Scope binding mismatch.');
      if (mode === 'resume' && !old)
        throw new TransferTrustError('CAS_HISTORY_MISSING', 'Absent independent CAS history.');
      const epoch = (old?.epoch ?? 0) + 1;
      const token = 'SYNTHETIC-ONLY-NOT-EXTERNAL-' + job.id + '-' + epoch;
      this.entries.set(job.id, { epoch, token, binding: this.binding(job) });
      return { epoch, token };
    },
    assertCurrent: async (job, lease) => { this.native(job, lease.epoch, lease.token); },
  };
  native(job: Readonly<TransferJob>, epoch: number, token: string) {
    const rec = this.entries.get(job.id);
    if (!rec || rec.epoch !== epoch || rec.token !== token ||
        rec.binding !== this.binding(job))
      throw new TransferTrustError('NATIVE_STALE_EPOCH', 'Atomic Native lease CAS refused.');
  }
}
class Grants {
  enabled = true;
  generation = 1;
  private readonly originalGeneration = new Map<string, number>();
  rePair() { this.generation++; }
  readonly adapter: TrustedTransferCoreGrants = {
    assertCurrent: async (job) => { this.check(job); },
  };
  check(job: Readonly<TransferJob>) {
    if (!this.enabled || job.accountId !== input.accountId ||
        job.projectId !== input.projectId ||
        job.sourceDeviceId !== input.sourceDeviceId ||
        job.targetDeviceId !== input.targetDeviceId)
      throw new TransferTrustError('CORE_OWNER_REVOKED', 'Current grant denied.');
    const old = this.originalGeneration.get(job.id);
    if (old !== undefined && old !== this.generation)
      throw new TransferTrustError('CORE_GRANT_EPOCH_STALE', 'Re-pair invalidated this job grant.');
    if (old === undefined) this.originalGeneration.set(job.id, this.generation);
  }
}
type Hooks = {
  beforeRead?: (device: string, file: string, offset: number) => Promise<void>;
  beforeWrite?: (job: Readonly<TransferJob>, env: Readonly<FencedWriteEnvelope>) => Promise<void>;
  afterWrite?: (job: Readonly<TransferJob>, env: Readonly<FencedWriteEnvelope>) => Promise<void>;
  beforePublish?: (job: Readonly<TransferJob>) => Promise<void>;
};
type Mode = 'normal' | 'lost-ack' | 'forged-receipt' | 'corrupt-stage';
function mock(mode: Mode = 'normal', hooks: Hooks = {}) {
  const cas = new Cas(), grants = new Grants();
  const stages = new Map<string, Buffer>();
  const writes: Array<{ id: string; offset: number; epoch: number }> = [];
  let target: Buffer | undefined, publications = 0, lost = false;
  const fileContent = (device: string, file: string) =>
    device === input.sourceDeviceId ? bytes :
      file === input.targetPath ? target : stages.get(file);
  const remote: TransferRemote = {
    stat: async (device, file) => {
      const value = fileContent(device, file);
      if (!value) throw notFound();
      return { type: 'file', size: value.length,
        ...(device === input.sourceDeviceId ? { modifiedAt: 'fixture-immutable' } : {}) };
    },
    hash: async (device, file) => {
      const value = fileContent(device, file);
      if (!value) throw notFound();
      return digest(value);
    },
    read: async (device, file, offset, max) => {
      const value = fileContent(device, file);
      if (!value) throw notFound();
      await hooks.beforeRead?.(device, file, offset);
      const chunk = value.subarray(offset, offset + max);
      return { sourceBytes: value.length, offsetBytes: offset,
        bytesRead: chunk.length, contentBase64: chunk.toString('base64') };
    },
    write: async () => { throw Error('UNFENCED_WRITE_FORBIDDEN'); },
    moveNoOverwrite: async () => { throw Error('UNFENCED_PUBLISH_FORBIDDEN'); },
    writeFenced: async (job, env, encoded, first) => {
      await hooks.beforeWrite?.(job, env);
      // The Native epoch/scope CAS and append are atomic: no await between them.
      cas.native(job, env.epoch, env.token);
      grants.check(job);
      const chunk = Buffer.from(encoded, 'base64');
      assert.equal(chunk.length, env.length);
      assert.equal(digest(chunk), env.sha256);
      const old = stages.get(job.stagePath);
      if (first ? old !== undefined || env.offset !== 0 :
        !old || old.length !== env.offset)
        throw new TransferTrustError('NATIVE_OFFSET_CAS', 'Stale Native offset.');
      const actual = Buffer.from(chunk);
      if (mode === 'corrupt-stage' && env.offset === 0)
        actual[0] = actual[0]! ^ 0xff;
      stages.set(job.stagePath, old ? Buffer.concat([old, actual]) : actual);
      writes.push({ id: job.id, offset: env.offset, epoch: env.epoch });
      await hooks.afterWrite?.(job, env);
      if (mode === 'lost-ack' && !lost) {
        lost = true; throw Error('DISPATCHED_ACK_LOST');
      }
      return { requestId: env.requestId, epoch: env.epoch, offset: env.offset,
        length: env.length, sha256: mode === 'forged-receipt' && env.offset === 0
          ? '0'.repeat(64) : env.sha256 };
    },
    publishFenced: async (job, epoch, token) => {
      await hooks.beforePublish?.(job);
      cas.native(job, epoch, token);
      grants.check(job);
      const stage = stages.get(job.stagePath);
      if (!stage || digest(stage) !== digest(bytes)) throw Error('NATIVE_BAD_STAGE');
      if (target !== undefined) throw Error('NATIVE_DESTINATION_EXISTS');
      target = Buffer.from(stage); publications++;
    },
  };
  const hub = (root: string) => new CrossDeviceTransferJobs(root, remote,
    { requireExternalAuthority: true, authority: cas.authority, grants: grants.adapter });
  return { cas, grants, hub, writes,
    get target() { return target; }, get publications() { return publications; } };
}

test('#22 stale external epoch between Hub precheck and Native mutation never writes', async () =>
  temp(async root => {
    const entered = gate(), release = gate();
    const fx = mock('normal', { beforeWrite: async () => {
      entered.open(); await release.promise;
    } });
    const a = fx.hub(root), start = await a.start(input);
    await expectGate(entered.promise, 'Native dispatch');
    const old = await stored(root, start.id);
    assert.equal(old.pending?.offset, 0);
    const next = await fx.cas.authority.acquire(old, 'resume');
    assert.ok(next.epoch > old.fencing!.epoch);
    release.open();
    await a.waitForIdle(start.id);
    const job = await stored(root, start.id);
    assert.equal(job.state, 'MUTATION_UNKNOWN');
    assert.equal(job.bytesConfirmed, 0);
    assert.equal(fx.writes.length, 0);
    assert.equal(fx.publications, 0);
  }));

test('#22 CORE revoke mid-chunk denies other Hub status/cancel and Native dispatch', async () =>
  temp(async root => {
    const entered = gate(), release = gate();
    const fx = mock('normal', { beforeWrite: async () => {
      entered.open(); await release.promise;
    } });
    const a = fx.hub(root), b = fx.hub(root);
    const start = await a.start(input);
    await expectGate(entered.promise, 'mid-chunk revocation');
    fx.grants.enabled = false;
    await assert.rejects(b.status(start.id, input.accountId,
      input.sourceDeviceId, input.targetDeviceId),
    (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_OWNER_REVOKED');
    await assert.rejects(b.cancel(start.id, input.accountId,
      input.sourceDeviceId, input.targetDeviceId),
    (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_OWNER_REVOKED');
    release.open();
    await a.waitForIdle(start.id);
    assert.equal((await stored(root, start.id)).state, 'MUTATION_UNKNOWN');
    assert.equal(fx.writes.length, 0);
    assert.equal(fx.publications, 0);
  }));

for (const mode of ['forged-receipt', 'corrupt-stage'] as const) {
  test('#22 ' + mode + ' cannot credit fake checksum or publish', async () =>
    temp(async root => {
      const fx = mock(mode), a = fx.hub(root);
      const start = await a.start(input);
      await a.waitForIdle(start.id);
      const job = await stored(root, start.id);
      assert.equal(job.state, 'MUTATION_UNKNOWN');
      assert.equal(job.errorCode, 'FORGED_WRITE_RECEIPT');
      assert.equal(job.bytesConfirmed, 0);
      assert.equal(job.pending?.offset, 0);
      assert.equal(fx.writes.length, 1);
      assert.equal(fx.publications, 0);
    }));
}

test('#22 other Hub cancel during dispatched Native write => UNKNOWN and zero replay', async () =>
  temp(async root => {
    const entered = gate(), release = gate();
    const fx = mock('normal', { afterWrite: async () => {
      entered.open(); await release.promise;
    } });
    const a = fx.hub(root), b = fx.hub(root);
    const start = await a.start(input);
    await expectGate(entered.promise, 'Native write ACK pending');
    assert.equal(fx.writes.length, 1);
    const pending = await b.status(start.id, input.accountId,
      input.sourceDeviceId, input.targetDeviceId);
    assert.equal(pending.bytesConfirmed, 0);
    const cancel = await b.cancel(start.id, input.accountId,
      input.sourceDeviceId, input.targetDeviceId);
    assert.equal(cancel.state, 'CANCEL_REQUESTED');
    release.open();
    await a.waitForIdle(start.id);
    const job = await stored(root, start.id);
    assert.equal(job.state, 'MUTATION_UNKNOWN');
    assert.equal(job.bytesConfirmed, 0);
    assert.equal(job.pending?.offset, 0);
    assert.equal(fx.writes.length, 1);
    assert.equal(fx.publications, 0);
    assert.equal((await b.status(start.id, input.accountId,
      input.sourceDeviceId, input.targetDeviceId)).state, 'MUTATION_UNKNOWN');
    assert.equal(fx.writes.length, 1);
  }));

test('#22 lost ACK: explicit second Hub resume acquires higher epoch, never replays offset 0', async () =>
  temp(async root => {
    const fx = mock('lost-ack'), a = fx.hub(root);
    const start = await a.start(input);
    await a.waitForIdle(start.id);
    assert.equal((await stored(root, start.id)).state, 'MUTATION_UNKNOWN');
    const b = fx.hub(root);
    assert.equal((await b.status(start.id, input.accountId,
      input.sourceDeviceId, input.targetDeviceId)).state, 'MUTATION_UNKNOWN');
    assert.equal(fx.writes.length, 1);
    const resume = await b.start({ ...input, resumeTransferId: start.id });
    assert.equal(resume.bytesConfirmed, 65_536);
    await b.waitForIdle(start.id);
    const done = await stored(root, start.id);
    assert.equal(done.state, 'COMPLETED');
    assert.equal(done.bytesConfirmed, bytes.length);
    assert.equal(fx.writes.filter(x => x.offset === 0).length, 1);
    assert.equal(new Set(fx.writes.map(x => x.offset)).size, 3);
    assert.equal(fx.publications, 1);
    assert.deepEqual(fx.target, bytes);
  }));

test('#22 two Hub concurrent start/publication => one destination, one winner', async () =>
  temp(async root => {
    const reachedBoth = gate(), release = gate();
    let contenders = 0;
    const fx = mock('normal', { beforePublish: async () => {
      if (++contenders === 2) reachedBoth.open();
      await release.promise;
    } });
    const a = fx.hub(root), b = fx.hub(root);
    const [first, second] = await Promise.all([a.start(input), b.start(input)]);
    assert.notEqual(first.id, second.id);
    await expectGate(reachedBoth.promise, 'both Hub publishers');
    release.open();
    await Promise.all([a.waitForIdle(first.id), b.waitForIdle(second.id)]);
    const states = [(await stored(root, first.id)).state, (await stored(root, second.id)).state];
    assert.equal(states.filter(x => x === 'COMPLETED').length, 1);
    assert.equal(states.filter(x => x === 'MUTATION_UNKNOWN').length, 1);
    assert.equal(fx.publications, 1);
    assert.deepEqual(fx.target, bytes);
    assert.equal(fx.writes.filter(x => x.id === first.id).length, 3);
    assert.equal(fx.writes.filter(x => x.id === second.id).length, 3);
  }));

/**
 * Follow-up #22 acceptance: synthetic external CAS, TEMP-only journal and
 * mock Native provider are NON-AUTHORITATIVE; no signed Agent evidence.
 * Explicit Promise gates eliminate timing-based ordering or 120ms sleeps.
 */
test('#22 next: published once while second Hub source chunk waits then CORE revoked', async () =>
  temp(async root => {
    const reading = gate(), releaseRead = gate();
    let hold = true;
    const fx = mock('normal', { beforeRead: async (device, _file, offset) => {
      if (hold && device === input.sourceDeviceId && offset === 0) {
        reading.open();
        await releaseRead.promise;
      }
    } });
    const hubA = fx.hub(root), hubB = fx.hub(root);
    const parked = await hubB.start(input);
    try {
      await expectGate(reading.promise, 'Hub B parked in source read');
      hold = false;
      const winner = await hubA.start(input);
      await hubA.waitForIdle(winner.id);
      assert.equal((await stored(root, winner.id)).state, 'COMPLETED');
      assert.equal(fx.publications, 1);
      fx.grants.enabled = false;
      releaseRead.open();
      await hubB.waitForIdle(parked.id);
      const denied = await stored(root, parked.id);
      assert.equal(denied.state, 'MUTATION_UNKNOWN');
      assert.equal(denied.errorCode, 'CORE_OWNER_REVOKED');
      assert.equal(denied.bytesConfirmed, 0);
      assert.equal(fx.writes.filter(w => w.id === parked.id).length, 0);
      assert.equal(fx.publications, 1);
      assert.deepEqual(fx.target, bytes);
      await assert.rejects(hubB.status(parked.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_OWNER_REVOKED');
    } finally {
      releaseRead.open();
      await hubB.waitForIdle(parked.id);
    }
  }));

test('#22 next: two publishers race; one commits, CORE revoke denies other Native publish', async () =>
  temp(async root => {
    const twoAtPublish = gate();
    const held = new Map<string, ReturnType<typeof gate>>();
    const fx = mock('normal', { beforePublish: async job => {
      const admission = gate();
      held.set(job.id, admission);
      if (held.size === 2) twoAtPublish.open();
      await admission.promise;
    } });
    const a = fx.hub(root), b = fx.hub(root);
    const [first, second] = await Promise.all([a.start(input), b.start(input)]);
    try {
      await expectGate(twoAtPublish.promise, 'both Native publishers');
      assert.equal(held.size, 2);
      held.get(first.id)!.open();
      await a.waitForIdle(first.id);
      assert.equal((await stored(root, first.id)).state, 'COMPLETED');
      assert.equal(fx.publications, 1);
      fx.grants.enabled = false;
      held.get(second.id)!.open();
      await b.waitForIdle(second.id);
      const loser = await stored(root, second.id);
      assert.equal(loser.state, 'MUTATION_UNKNOWN');
      assert.equal(loser.bytesConfirmed, bytes.length);
      assert.equal(loser.errorCode, 'TRANSFER_PUBLISH_OUTCOME_UNKNOWN');
      assert.equal(fx.publications, 1);
      assert.deepEqual(fx.target, bytes);
      assert.equal(fx.writes.filter(w => w.id === first.id).length, 3);
      assert.equal(fx.writes.filter(w => w.id === second.id).length, 3);
    } finally {
      for (const entry of held.values()) entry.open();
      await Promise.all([a.waitForIdle(first.id), b.waitForIdle(second.id)]);
    }
  }));

test('#22 next: restored old journal and CORE re-pair cannot revive in-flight Native epoch lease', async () =>
  temp(async root => {
    const entered = gate(), dispatch = gate();
    const fx = mock('normal', { beforeWrite: async (_job, env) => {
      if (env.offset === 0) { entered.open(); await dispatch.promise; }
    } });
    const hubA = fx.hub(root), first = await hubA.start(input);
    const filename = path.join(root, first.id + '.json');
    try {
      await expectGate(entered.promise, 'old Hub Native write held');
      const snapshot = await fs.readFile(filename, 'utf8');
      const previous = JSON.parse(snapshot) as TransferJob;
      assert.equal(previous.pending?.offset, 0);
      const greater = await fx.cas.authority.acquire(previous, 'resume');
      assert.ok(greater.epoch > previous.fencing!.epoch);
      fx.grants.rePair();
      // Local-only restore; independent emulator epoch + grant generation
      // must NOT roll back together with this synthetic TEMP journal.
      await fs.writeFile(filename, snapshot);
      dispatch.open();
      await hubA.waitForIdle(first.id);
      const stale = await stored(root, first.id);
      assert.equal(stale.state, 'MUTATION_UNKNOWN');
      assert.equal(stale.bytesConfirmed, 0);
      assert.equal(fx.writes.filter(w => w.id === first.id).length, 0);
      assert.equal(fx.publications, 0);
      const hubB = fx.hub(root);
      await assert.rejects(hubB.status(first.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_GRANT_EPOCH_STALE');
      await assert.rejects(hubB.cancel(first.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_GRANT_EPOCH_STALE');
      await assert.rejects(hubB.start({ ...input, resumeTransferId: first.id }),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_GRANT_EPOCH_STALE');
      const fresh = await hubB.start(input);
      await hubB.waitForIdle(fresh.id);
      assert.equal((await stored(root, fresh.id)).state, 'COMPLETED');
      assert.equal(fx.writes.filter(w => w.id === first.id).length, 0);
      assert.equal(fx.writes.filter(w => w.id === fresh.id).length, 3);
      assert.equal(fx.publications, 1);
      assert.deepEqual(fx.target, bytes);
    } finally {
      dispatch.open();
      await hubA.waitForIdle(first.id);
    }
  }));

test('#22 next: dispatched lost ACK and local rollback after re-pair do not replay old lease', async () =>
  temp(async root => {
    const fx = mock('lost-ack'), oldHub = fx.hub(root);
    const old = await oldHub.start(input);
    await oldHub.waitForIdle(old.id);
    const filename = path.join(root, old.id + '.json');
    const snapshot = await fs.readFile(filename, 'utf8');
    const previous = JSON.parse(snapshot) as TransferJob;
    assert.equal(previous.state, 'MUTATION_UNKNOWN');
    assert.equal(previous.pending?.offset, 0);
    assert.equal(fx.writes.filter(w => w.id === old.id).length, 1);
    const next = await fx.cas.authority.acquire(previous, 'resume');
    assert.ok(next.epoch > previous.fencing!.epoch);
    fx.grants.rePair();
    await fs.writeFile(filename, snapshot);
    const otherHub = fx.hub(root);
    await assert.rejects(otherHub.start({ ...input, resumeTransferId: old.id }),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_GRANT_EPOCH_STALE');
    assert.equal(fx.writes.filter(w => w.id === old.id).length, 1);
    assert.equal(fx.publications, 0);
    const replacement = await otherHub.start(input);
    await otherHub.waitForIdle(replacement.id);
    assert.equal((await stored(root, replacement.id)).state, 'COMPLETED');
    assert.equal(fx.writes.filter(w => w.id === old.id).length, 1);
    assert.equal(fx.writes.filter(w => w.id === replacement.id).length, 3);
    assert.equal(fx.publications, 1);
    assert.deepEqual(fx.target, bytes);
  }));
