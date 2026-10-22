import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CrossDeviceTransferJobs, type TransferJob, type TransferRemote }
  from '../src/mcp/cross-device-transfer-jobs.js';
import { TransferTrustError, type TrustedTransferAuthority,
  type TrustedTransferCoreGrants, type FencedWriteEnvelope,
  type FencedFinalReceipt, type TrustedFinalReceiptVerifier }
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
  // A deterministic LOGICAL clock. This in-memory model is not an external
  // monotonic witness and cannot survive real process/authority rollback.
  private tick = 0;
  readonly entries = new Map<string, {
    epoch: number; token: string; binding: string; expiresAt: number;
  }>();
  expireAll() { this.tick += 100; }
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
      this.entries.set(job.id, { epoch, token, binding: this.binding(job), expiresAt: this.tick + 100 });
      return { epoch, token };
    },
    assertCurrent: async (job, lease) => { this.native(job, lease.epoch, lease.token); },
  };
  native(job: Readonly<TransferJob>, epoch: number, token: string) {
    const rec = this.entries.get(job.id);
    if (!rec || rec.epoch !== epoch || rec.token !== token ||
        rec.binding !== this.binding(job))
      throw new TransferTrustError('NATIVE_STALE_EPOCH', 'Atomic Native lease CAS refused.');
    if (this.tick >= rec.expiresAt)
      throw new TransferTrustError('NATIVE_LEASE_EXPIRED', 'Expired Native lease cannot mutate.');
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
  afterPublish?: (job: Readonly<TransferJob>, receipt: FencedFinalReceipt) => Promise<void>;
  beforeFinalVerify?: (job: Readonly<TransferJob>, receipt: FencedFinalReceipt) => Promise<void>;
};
type Mode = 'normal' | 'lost-ack' | 'forged-receipt' | 'corrupt-stage' |
  'lost-publish-ack' | 'forged-second-request-id';

/** Synthetic key-bound receipt. NOT a deployed Agent signer or a production proof. */
type SyntheticPublishedReceipt = {
  jobId: string; accountId: string; projectId: string;
  targetDeviceId: string; targetPath: string; sha256: string;
  epoch: number; grantGeneration: number; mac: string;
};
function mock(mode: Mode = 'normal', hooks: Hooks = {},
  strictFinalReceipt = false) {
  const cas = new Cas(), grants = new Grants();
  const stages = new Map<string, Buffer>();
  const writes: Array<{ id: string; offset: number; epoch: number }> = [];
  let target: Buffer | undefined, publications = 0, lost = false;
  // Native mock alone owns this test key and emits a receipt only AFTER
  // successful no-replace publication, not after ACK or Hub state change.
  const nativeKey = randomBytes(32);
  const publishedReceipts: SyntheticPublishedReceipt[] = [];
  const finalReceipts: FencedFinalReceipt[] = [];
  const macFor = (claims: Omit<SyntheticPublishedReceipt, 'mac'>) =>
    createHmac('sha256', nativeKey).update(JSON.stringify(claims)).digest('hex');
  const verifyReceipt = (receipt: SyntheticPublishedReceipt) => {
    const { mac, ...claims } = receipt;
    if (!/^[a-f0-9]{64}$/.test(mac)) return false;
    const actual = Buffer.from(mac, 'hex');
    const expected = Buffer.from(macFor(claims), 'hex');
    return timingSafeEqual(actual, expected);
  };
  // Test-only synthetic attestation oracle, bound to FULL publication identity.
  // It is injected from the Hub fixture, not accepted from a tool caller.
  const finalSigner = (claims: Omit<FencedFinalReceipt, 'proof'>) =>
    createHmac('sha256', nativeKey).update(JSON.stringify(claims)).digest('hex');
  const finalVerifier: TrustedFinalReceiptVerifier = {
    verify: async (job, receipt) => {
      await hooks.beforeFinalVerify?.(job, receipt);
      const { proof, ...claims } = receipt;
      if (!/^[0-9a-f]{64}$/.test(proof)) return false;
      return timingSafeEqual(Buffer.from(proof, 'hex'),
        Buffer.from(finalSigner(claims), 'hex'));
    },
  };
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
      return { requestId: mode === 'forged-second-request-id' && env.offset === 65_536
          ? env.requestId.replace(/^./, env.requestId[0] === 'a' ? 'b' : 'a')
          : env.requestId,
        epoch: env.epoch, offset: env.offset,
        length: env.length, sha256: mode === 'forged-receipt' && env.offset === 0
          ? '0'.repeat(64) : env.sha256 };
    },
    publishFenced: async (job, epoch, token, requestId) => {
      await hooks.beforePublish?.(job);
      cas.native(job, epoch, token);
      grants.check(job);
      const stage = stages.get(job.stagePath);
      if (!stage || digest(stage) !== digest(bytes)) throw Error('NATIVE_BAD_STAGE');
      if (target !== undefined) throw Error('NATIVE_DESTINATION_EXISTS');
      target = Buffer.from(stage); publications++;
      const claims = { jobId: job.id, accountId: job.accountId,
        projectId: job.projectId, targetDeviceId: job.targetDeviceId,
        targetPath: job.targetPath, sha256: digest(stage), epoch,
        grantGeneration: grants.generation };
      publishedReceipts.push({ ...claims, mac: macFor(claims) });
      if (mode === 'lost-publish-ack') throw Error('NATIVE_PUBLISHED_BUT_ACK_LOST');
      if (strictFinalReceipt) {
        assert.ok(requestId, 'the durable publication requestId is passed to Native');
        const signedClaims: Omit<FencedFinalReceipt, 'proof'> = {
          requestId, jobId: job.id, accountId: job.accountId,
          projectId: job.projectId, targetDeviceId: job.targetDeviceId,
          targetPath: job.targetPath, bytesTotal: job.bytesTotal,
          sha256: digest(stage), epoch,
        };
        const receipt = { ...signedClaims, proof: finalSigner(signedClaims) };
        finalReceipts.push({ ...receipt });
        await hooks.afterPublish?.(job, receipt);
        return receipt;
      }
    },
  };
  const hub = (root: string) => new CrossDeviceTransferJobs(root, remote,
    { requireExternalAuthority: true, authority: cas.authority, grants: grants.adapter,
      ...(strictFinalReceipt ? {
        requireAuthenticatedFinalReceipt: true as const, finalReceiptVerifier: finalVerifier,
      } : {}) });
  return { cas, grants, hub, writes, verifyReceipt,
    get finalReceipts() { return finalReceipts.map(r => ({ ...r })); },
    get publishedReceipts() { return publishedReceipts.map(r => ({ ...r })); },
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
      // The outer worker retains the more specific trusted CORE revoke provenance.
      assert.equal(loser.errorCode, 'CORE_OWNER_REVOKED');
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

/**
 * QA #22 follow-up: source-only, in-memory Native signer and external CAS
 * simulator. This is NOT an OS/Agent/physical durability attestation.
 * Barriers order races; their timeout only detects a deadlock.
 */
test('#22 gate: revoke CORE after one independently verified 64KiB chunk, never credit next write', async () =>
  temp(async root => {
    const verifiedFirst = gate(), releaseRead = gate();
    const fx = mock('normal', { beforeRead: async (device, _file, offset) => {
      // The second source read is entered only after first-chunk Native
      // readback passed and bytesConfirmed was journaled to 65536.
      if (device === input.sourceDeviceId && offset === 65_536) {
        verifiedFirst.open(); await releaseRead.promise;
      }
    } });
    const hubA = fx.hub(root), hubB = fx.hub(root);
    const started = await hubA.start(input);
    try {
      await expectGate(verifiedFirst.promise, 'first chunk externally read back');
      const before = await stored(root, started.id);
      assert.equal(before.state, 'RUNNING');
      assert.equal(before.bytesConfirmed, 65_536);
      assert.equal(before.pending, undefined);
      assert.equal(fx.writes.length, 1);
      fx.grants.enabled = false;
      releaseRead.open();
      await hubA.waitForIdle(started.id);
      const after = await stored(root, started.id);
      assert.equal(after.state, 'MUTATION_UNKNOWN');
      assert.equal(after.errorCode, 'CORE_OWNER_REVOKED');
      assert.equal(after.bytesConfirmed, 65_536);
      assert.equal(after.pending?.offset, 65_536);
      assert.equal(fx.writes.length, 1);
      assert.equal(fx.publications, 0);
      assert.equal(fx.publishedReceipts.length, 0);
      await assert.rejects(hubB.status(started.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_OWNER_REVOKED');
    } finally {
      releaseRead.open();
      await hubA.waitForIdle(started.id);
    }
  }));

test('#22 gate: lease expiry while PUBLISHING fences old Hub, only new job signs one receipt', async () =>
  temp(async root => {
    const entered = gate(), dispatch = gate();
    let suspendOld = true;
    const fx = mock('normal', { beforePublish: async () => {
      if (suspendOld) {
        suspendOld = false; entered.open(); await dispatch.promise;
      }
    } });
    const hubA = fx.hub(root);
    const old = await hubA.start(input);
    try {
      await expectGate(entered.promise, 'old Hub pending Native publish');
      const pending = await stored(root, old.id);
      assert.equal(pending.state, 'PUBLISHING');
      assert.equal(pending.bytesConfirmed, bytes.length);
      assert.equal(fx.writes.filter(x => x.id === old.id).length, 3);
      assert.equal(fx.publishedReceipts.length, 0);
      fx.cas.expireAll(); // deterministic logical expiry, no clock sleeps
      dispatch.open();
      await hubA.waitForIdle(old.id);
      const rejected = await stored(root, old.id);
      assert.equal(rejected.state, 'MUTATION_UNKNOWN');
      assert.equal(rejected.bytesConfirmed, bytes.length);
      assert.equal(rejected.errorCode, 'NATIVE_LEASE_EXPIRED');
      assert.equal(fx.publications, 0);
      assert.equal(fx.publishedReceipts.length, 0);
      const hubB = fx.hub(root);
      assert.equal((await hubB.status(old.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId)).state, 'MUTATION_UNKNOWN');
      const fresh = await hubB.start(input);
      await hubB.waitForIdle(fresh.id);
      assert.equal((await stored(root, fresh.id)).state, 'COMPLETED');
      assert.equal(fx.publications, 1);
      const receipts = fx.publishedReceipts;
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]!.jobId, fresh.id);
      assert.equal(receipts[0]!.sha256, digest(bytes));
      assert.equal(fx.verifyReceipt(receipts[0]!), true);
      assert.deepEqual(fx.target, bytes);
    } finally {
      dispatch.open();
      await hubA.waitForIdle(old.id);
    }
  }));

test('#22 gate: CORE re-pair during pending Native publish cannot authenticate stale receipt', async () =>
  temp(async root => {
    const entered = gate(), dispatch = gate();
    let suspendOld = true;
    const fx = mock('normal', { beforePublish: async () => {
      if (suspendOld) {
        suspendOld = false; entered.open(); await dispatch.promise;
      }
    } });
    const a = fx.hub(root), b = fx.hub(root), old = await a.start(input);
    try {
      await expectGate(entered.promise, 'stale CORE owner publish');
      assert.equal((await stored(root, old.id)).state, 'PUBLISHING');
      fx.grants.rePair();
      dispatch.open();
      await a.waitForIdle(old.id);
      const rejected = await stored(root, old.id);
      assert.equal(rejected.state, 'MUTATION_UNKNOWN');
      assert.equal(rejected.errorCode, 'CORE_GRANT_EPOCH_STALE');
      assert.equal(fx.publications, 0);
      assert.equal(fx.publishedReceipts.length, 0);
      await assert.rejects(b.status(old.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_GRANT_EPOCH_STALE');
      const current = await b.start(input);
      await b.waitForIdle(current.id);
      assert.equal((await stored(root, current.id)).state, 'COMPLETED');
      const [receipt] = fx.publishedReceipts;
      assert.equal(fx.publishedReceipts.length, 1);
      assert.ok(receipt);
      assert.equal(receipt.jobId, current.id);
      assert.equal(receipt.grantGeneration, fx.grants.generation);
      assert.equal(fx.verifyReceipt(receipt), true);
      assert.equal(fx.verifyReceipt({ ...receipt, accountId: 'forged-account' }), false);
      assert.equal(fx.verifyReceipt({ ...receipt, epoch: receipt.epoch + 1 }), false);
      assert.equal(fx.verifyReceipt({ ...receipt, sha256: 'f'.repeat(64) }), false);
    } finally {
      dispatch.open();
      await a.waitForIdle(old.id);
    }
  }));

test('#22 gate: lost publish ACK yields one signed Native receipt but Hub UNKNOWN, no inferred durability', async () =>
  temp(async root => {
    const fx = mock('lost-publish-ack');
    const a = fx.hub(root), b = fx.hub(root);
    const job = await a.start(input);
    await a.waitForIdle(job.id);
    const state = await stored(root, job.id);
    assert.equal(state.state, 'MUTATION_UNKNOWN');
    assert.equal(state.bytesConfirmed, bytes.length);
    assert.equal(state.pending, undefined);
    assert.equal((await b.status(job.id, input.accountId,
      input.sourceDeviceId, input.targetDeviceId)).state, 'MUTATION_UNKNOWN');
    // Synthetic native signer's receipt is independent of a lost ACK and
    // cannot be asserted by arbitrary client data or upgraded via Hub status.
    const receipts = fx.publishedReceipts;
    assert.equal(fx.publications, 1);
    assert.equal(receipts.length, 1);
    const [receipt] = receipts;
    assert.ok(receipt);
    assert.equal(receipt.jobId, job.id);
    assert.equal(receipt.sha256, digest(bytes));
    assert.equal(fx.verifyReceipt(receipt), true);
    assert.equal(fx.verifyReceipt({ ...receipt, targetPath: '/foreign/path' }), false);
    assert.equal(fx.verifyReceipt({ ...receipt, mac: '0'.repeat(64) }), false);
    assert.deepEqual(fx.target, bytes);
    // Neither status nor the Native ledger is an automatic Hub COMPLETED
    // transition; readback reconciliation must be independently authenticated.
    assert.equal((await stored(root, job.id)).state, 'MUTATION_UNKNOWN');
    assert.equal(fx.publishedReceipts.length, 1);
  }));

test('#22 P0 acceptance RED until #08: late cancel cannot downgrade UNKNOWN after published ACK lost', async () =>
  temp(async root => {
    const fx = mock('lost-publish-ack'), a = fx.hub(root), b = fx.hub(root);
    const started = await a.start(input);
    await a.waitForIdle(started.id);
    assert.equal((await stored(root, started.id)).state, 'MUTATION_UNKNOWN');
    assert.equal(fx.publishedReceipts.length, 1);
    // The Native side effect MAY have succeeded (and did in this isolated
    // fixture). A later Hub may NOT call it CANCELLED without an independently
    // authenticated fence/receipt or deletion proof.
    const canceled = await b.cancel(started.id, input.accountId,
      input.sourceDeviceId, input.targetDeviceId);
    assert.equal(canceled.state, 'MUTATION_UNKNOWN',
      'late cancel must preserve unknown physical mutation, not invent CANCELLED');
    assert.equal((await stored(root, started.id)).state, 'MUTATION_UNKNOWN');
    assert.equal(fx.publishedReceipts.length, 1);
  }));

/**
 * #691 integration acceptance on its EXACT source HEAD.
 * This file is copied unchanged from #682, followed by independent #22
 * gates below. No physical Agent, external CAS, VM, or trusted durability.
 */
test('#22/#691: second Hub cancels RESERVED second chunk after first verified 64KiB', async () =>
  temp(async root => {
    const entered = gate(), release = gate();
    const fx = mock('normal');
    const assertOriginal = fx.cas.authority.assertCurrent;
    let held = false;
    fx.cas.authority.assertCurrent = async (job, lease, phase, offset) => {
      await assertOriginal(job, lease, phase, offset);
      if (!held && phase === 'WRITE' && offset === 65_536) {
        const snapshot = await stored(root, job.id);
        if (snapshot.pending?.offset === 65_536 &&
            snapshot.pending.dispatched === false) {
          held = true;
          entered.open();
          await release.promise;
        }
      }
    };
    const a = fx.hub(root), b = fx.hub(root);
    const first = await a.start(input);
    try {
      await expectGate(entered.promise, 'durable second undispatched reservation');
      const before = await stored(root, first.id);
      assert.equal(before.state, 'RUNNING');
      assert.equal(before.bytesConfirmed, 65_536);
      assert.equal(before.pending?.offset, 65_536);
      assert.equal(before.pending?.dispatched, false);
      assert.equal(fx.writes.length, 1);
      const requested = await b.cancel(first.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId);
      assert.equal(requested.state, 'CANCEL_REQUESTED');
      release.open();
      await a.waitForIdle(first.id);
      const result = await stored(root, first.id);
      assert.equal(result.state, 'MUTATION_UNKNOWN',
        'prior confirmed Native bytes preclude side-effect-free CANCELLED');
      assert.equal(result.bytesConfirmed, 65_536);
      assert.equal(result.pending?.dispatched, false);
      assert.equal(fx.writes.length, 1);
      assert.equal(fx.publications, 0);
      assert.equal(fx.publishedReceipts.length, 0);
      assert.equal((await b.status(first.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId)).state, 'MUTATION_UNKNOWN');
    } finally {
      release.open();
      await a.waitForIdle(first.id);
    }
  }));

test('#22/#691: lease expiry after first receipt before Native dispatch cannot append or publish', async () =>
  temp(async root => {
    const entered = gate(), release = gate();
    const fx = mock('normal');
    const originalAssert = fx.cas.authority.assertCurrent;
    let held = false;
    fx.cas.authority.assertCurrent = async (job, lease, phase, offset) => {
      await originalAssert(job, lease, phase, offset);
      if (!held && phase === 'WRITE' && offset === 65_536) {
        const snapshot = await stored(root, job.id);
        if (snapshot.pending?.dispatched === false &&
            snapshot.pending.offset === 65_536) {
          held = true; entered.open(); await release.promise;
        }
      }
    };
    const a = fx.hub(root);
    const started = await a.start(input);
    try {
      await expectGate(entered.promise, 'pending second chunk before Native dispatch');
      const pending = await stored(root, started.id);
      assert.equal(pending.bytesConfirmed, 65_536);
      assert.equal(pending.pending?.dispatched, false);
      fx.cas.expireAll(); // deterministic test-only logical expiry
      release.open();
      await a.waitForIdle(started.id);
      const unknown = await stored(root, started.id);
      assert.equal(unknown.state, 'MUTATION_UNKNOWN');
      assert.equal(unknown.bytesConfirmed, 65_536);
      assert.equal(fx.writes.length, 1);
      assert.equal(fx.publications, 0);
      assert.equal(fx.publishedReceipts.length, 0);
      // No durability assertion is derived from the Hub error code.
    } finally {
      release.open(); await a.waitForIdle(started.id);
    }
  }));

test('#22/#691: stale synthetic publish receipt after CORE re-pair is not current-owner proof', async () =>
  temp(async root => {
    const fx = mock('lost-publish-ack');
    const a = fx.hub(root), b = fx.hub(root);
    const first = await a.start(input);
    await a.waitForIdle(first.id);
    const before = await stored(root, first.id);
    assert.equal(before.state, 'MUTATION_UNKNOWN');
    assert.equal(fx.publications, 1);
    const receipts = fx.publishedReceipts;
    assert.equal(receipts.length, 1);
    const [oldReceipt] = receipts;
    assert.ok(oldReceipt);
    assert.equal(fx.verifyReceipt(oldReceipt), true,
      'fixture HMAC authenticates a simulated provider only');
    const earlierGeneration = oldReceipt.grantGeneration;
    fx.grants.rePair();
    assert.notEqual(fx.grants.generation, earlierGeneration);
    assert.equal(fx.verifyReceipt(oldReceipt), true,
      'a valid OLD signature is not a current owner authorization');
    await assert.rejects(b.status(first.id, input.accountId,
      input.sourceDeviceId, input.targetDeviceId),
    (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_GRANT_EPOCH_STALE');
    await assert.rejects(b.cancel(first.id, input.accountId,
      input.sourceDeviceId, input.targetDeviceId),
    (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_GRANT_EPOCH_STALE');
    await assert.rejects(b.start({ ...input, resumeTransferId: first.id }),
    (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_GRANT_EPOCH_STALE');
    assert.equal((await stored(root, first.id)).state, 'MUTATION_UNKNOWN');
    assert.equal(fx.publishedReceipts.length, 1);
    assert.equal(fx.publications, 1);
  }));

test('#22/#691: stale publisher under lease expiry and CORE re-pair emits zero new receipts', async () =>
  temp(async root => {
    const reached = gate(), release = gate();
    let hold = true;
    const fx = mock('normal', { beforePublish: async () => {
      if (hold) { hold = false; reached.open(); await release.promise; }
    } });
    const a = fx.hub(root), b = fx.hub(root);
    const old = await a.start(input);
    try {
      await expectGate(reached.promise, 'old worker fenced at pending publish');
      const snapshot = await stored(root, old.id);
      assert.equal(snapshot.state, 'PUBLISHING');
      assert.equal(snapshot.bytesConfirmed, bytes.length);
      assert.equal(fx.publishedReceipts.length, 0);
      fx.cas.expireAll();
      fx.grants.rePair();
      release.open();
      await a.waitForIdle(old.id);
      const persisted = await stored(root, old.id);
      assert.equal(persisted.state, 'MUTATION_UNKNOWN');
      assert.equal(persisted.bytesConfirmed, bytes.length);
      assert.equal(fx.publications, 0);
      assert.equal(fx.publishedReceipts.length, 0);
      await assert.rejects(b.status(old.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_GRANT_EPOCH_STALE');
      const fresh = await b.start(input);
      await b.waitForIdle(fresh.id);
      const done = await stored(root, fresh.id);
      assert.equal(done.state, 'COMPLETED');
      assert.equal(fx.publications, 1);
      const receipts = fx.publishedReceipts;
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]!.jobId, fresh.id);
      assert.equal(receipts[0]!.grantGeneration, fx.grants.generation);
      assert.equal(fx.verifyReceipt(receipts[0]!), true);
    } finally {
      release.open(); await a.waitForIdle(old.id);
    }
  }));

/**
 * Independent #22 vs #725 adversarial gate: at the second Native write,
 * the in-memory stage already changed, but its forged ACK has NOT returned.
 * A different Hub requests cancellation, then CORE is revoked. The
 * immediately observed forged requestId must NOT be overwritten by a
 * generic cancel error, credited as verified, replayed, or published.
 *
 * #712's single-use Broker dispatch permission is a DIFFERENT authority
 * domain; no Broker->transfer end-to-end proof is asserted here.
 */
test('#22/#725: post-first-verified-chunk cancel plus CORE revoke preserves forged requestId provenance', async () =>
  temp(async root => {
    const wroteSecond = gate(), releaseAck = gate();
    let forbiddenThirdRead = 0;
    const fx = mock('forged-second-request-id', {
      beforeRead: async (device, _path, offset) => {
        if (device === input.sourceDeviceId && offset === 2 * 65_536)
          forbiddenThirdRead++;
      },
      afterWrite: async (_job, envelope) => {
        if (envelope.offset === 65_536) {
          wroteSecond.open();
          await releaseAck.promise;
        }
      },
    });
    const hubA = fx.hub(root), hubB = fx.hub(root);
    const started = await hubA.start(input);
    try {
      await expectGate(wroteSecond.promise, 'second Native side effect before forged ACK');
      const before = await stored(root, started.id);
      assert.equal(before.state, 'RUNNING');
      assert.equal(before.bytesConfirmed, 65_536,
        'first 64KiB independently verified, second remains unconfirmed');
      assert.equal(before.pending?.offset, 65_536);
      assert.equal(before.pending?.dispatched, true);
      assert.equal(before.pending?.length, 65_536);
      assert.equal(before.pending?.sha256, digest(bytes.subarray(65_536, 2 * 65_536)),
        'forensic intent must bind the actual second chunk digest');
      assert.equal(typeof before.pending?.requestId, 'string');
      const originalRequestId = before.pending!.requestId;
      assert.deepEqual(fx.writes.map(w => w.offset), [0, 65_536]);
      assert.equal(fx.publications, 0);
      const cancelled = await hubB.cancel(started.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId);
      assert.equal(cancelled.state, 'CANCEL_REQUESTED');
      fx.grants.enabled = false;
      releaseAck.open();
      await hubA.waitForIdle(started.id);
      const after = await stored(root, started.id);
      assert.equal(after.state, 'MUTATION_UNKNOWN',
        'a real-possible Native side effect cannot become CANCELLED');
      assert.equal(after.errorCode, 'FORGED_WRITE_RECEIPT',
        'preserve exact forged requestId provenance despite concurrent revoke');
      assert.equal(after.bytesConfirmed, 65_536,
        'forged ACK must not credit second Native side effect');
      assert.equal(after.pending?.requestId, originalRequestId,
        'durable request identity must not be rewritten by forged ACK');
      assert.equal(after.pending?.offset, 65_536);
      assert.equal(after.pending?.dispatched, true);
      assert.deepEqual(fx.writes.map(w => w.offset), [0, 65_536]);
      assert.equal(forbiddenThirdRead, 0);
      assert.equal(fx.publications, 0);
      assert.equal(fx.publishedReceipts.length, 0);
      await assert.rejects(hubB.status(started.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_OWNER_REVOKED');
    } finally {
      releaseAck.open();
      await hubA.waitForIdle(started.id);
    }
  }));

/**
 * #22 independent vs #725: a *valid* delayed ACK is still stale after the
 * owner CORE revoke. The injected Native provider already changed stage
 * bytes, and a second Hub has asked to cancel. No signed claim from #712
 * is asserted or reused as Transfer authority. No physical durability proof.
 */
test('#22/#725 late valid Native ACK after verified first chunk, Hub-B cancel and CORE revoke stays UNKNOWN', async () =>
  temp(async root => {
    const secondSideEffect = gate(), releaseAck = gate();
    let forbiddenRead = 0;
    const fx = mock('normal', {
      beforeRead: async (device, _path, offset) => {
        if (device === input.sourceDeviceId && offset === 2 * 65_536)
          forbiddenRead++;
      },
      afterWrite: async (_job, env) => {
        if (env.offset === 65_536) {
          secondSideEffect.open();
          await releaseAck.promise;
        }
      },
    });
    const hubA = fx.hub(root), hubB = fx.hub(root);
    const running = await hubA.start(input);
    try {
      await expectGate(secondSideEffect.promise, 'second Native write performed before late valid ACK');
      const journal = await stored(root, running.id);
      assert.equal(journal.state, 'RUNNING');
      assert.equal(journal.bytesConfirmed, 65_536);
      assert.equal(journal.pending?.offset, 65_536);
      assert.equal(journal.pending?.length, 65_536);
      assert.equal(journal.pending?.dispatched, true);
      assert.equal(journal.pending?.sha256, digest(bytes.subarray(65_536, 2 * 65_536)));
      const originalRequestId = journal.pending!.requestId;
      assert.equal(fx.writes.length, 2, 'Native stage may already have been modified');
      const pendingCancel = await hubB.cancel(running.id,
        input.accountId, input.sourceDeviceId, input.targetDeviceId);
      assert.equal(pendingCancel.state, 'CANCEL_REQUESTED');
      fx.grants.enabled = false;
      releaseAck.open();
      await hubA.waitForIdle(running.id);
      const state = await stored(root, running.id);
      assert.equal(state.state, 'MUTATION_UNKNOWN');
      assert.equal(state.errorCode, 'CORE_OWNER_REVOKED',
        'valid delayed ACK cannot override revoked effective CORE');
      assert.equal(state.bytesConfirmed, 65_536,
        'second Native effect is not verified after owner revoke');
      assert.equal(state.pending?.requestId, originalRequestId);
      assert.equal(state.pending?.offset, 65_536);
      assert.equal(state.pending?.dispatched, true);
      assert.deepEqual(fx.writes.map(w => w.offset), [0, 65_536]);
      assert.equal(forbiddenRead, 0);
      assert.equal(fx.publications, 0);
      assert.equal(fx.publishedReceipts.length, 0);
      await assert.rejects(hubB.status(running.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId),
      (error: unknown) =>
        error instanceof TransferTrustError && error.code === 'CORE_OWNER_REVOKED');
      await assert.rejects(hubB.start({ ...input, resumeTransferId: running.id }),
      (error: unknown) =>
        error instanceof TransferTrustError && error.code === 'CORE_OWNER_REVOKED');
      assert.equal((await stored(root, running.id)).state, 'MUTATION_UNKNOWN',
        'failed second-Hub re-open must not replay or clear uncertain outcome');
      assert.equal(fx.writes.length, 2);
      assert.equal(fx.publications, 0);
    } finally {
      releaseAck.open();
      await hubA.waitForIdle(running.id);
    }
  }));

/**
 * #22 / #754 hosted-final-ACK after Native commit:
 * The synthetic Native mock signs EXACT requestId + scope + epoch + SHA,
 * mutates the target once, then waits at a Promise barrier before returning
 * the real MAC-authenticated receipt. CORE revoked after physical-possible
 * side effect must deny completion; publication intent stays journaled and
 * its typed CORE error is not replaced by a later generic ACK/UNKNOWN.
 *
 * Does NOT constitute a real protected Agent signature, offhost CAS or
 * durable physical publication witness.
 */
test('#22/#754: revoked CORE after Native publish side effect rejects late authentic final ACK', async () =>
  temp(async root => {
    const nativePublished = gate(), releaseReceipt = gate();
    const fx = mock('normal', {
      afterPublish: async () => {
        nativePublished.open();
        await releaseReceipt.promise;
      },
    }, true);
    const hubA = fx.hub(root), hubB = fx.hub(root);
    const job = await hubA.start(input);
    try {
      await expectGate(nativePublished.promise, 'Native final side effect before valid ACK');
      const before = await stored(root, job.id);
      assert.equal(before.state, 'PUBLISHING');
      assert.equal(before.bytesConfirmed, bytes.length);
      assert.equal(before.pending, undefined, 'all writes read back before final publication');
      assert.equal(before.publication?.dispatched, true);
      assert.equal(before.publication?.sha256, digest(bytes));
      assert.equal(before.publication?.epoch, before.fencing?.epoch);
      const originalIntent = structuredClone(before.publication);
      assert.ok(originalIntent?.requestId);
      assert.equal(fx.finalReceipts.length, 1);
      assert.equal(fx.finalReceipts[0]!.requestId, originalIntent.requestId);
      assert.equal(fx.finalReceipts[0]!.epoch, originalIntent.epoch);
      assert.equal(fx.finalReceipts[0]!.sha256, originalIntent.sha256);
      assert.equal(fx.finalReceipts[0]!.jobId, job.id);
      assert.equal(fx.publications, 1);
      assert.equal(fx.publishedReceipts.length, 1);
      assert.deepEqual(fx.target, bytes);
      // The mock signing key is independent of the Hub ACK; authenticated
      // synthetic receipt exists but cannot grant an already-revoked CORE.
      fx.grants.enabled = false;
      releaseReceipt.open();
      await hubA.waitForIdle(job.id);
      const after = await stored(root, job.id);
      assert.equal(after.state, 'MUTATION_UNKNOWN');
      assert.equal(after.errorCode, 'CORE_OWNER_REVOKED');
      assert.deepEqual(after.publication, originalIntent);
      assert.equal(after.pending, undefined);
      assert.equal(after.bytesConfirmed, bytes.length);
      assert.equal(fx.publications, 1, 'no retry of potentially committed publish');
      assert.equal(fx.publishedReceipts.length, 1);
      await assert.rejects(hubB.status(job.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_OWNER_REVOKED');
      await assert.rejects(hubB.start({ ...input, resumeTransferId: job.id }),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_OWNER_REVOKED');
      assert.equal((await stored(root, job.id)).errorCode, 'CORE_OWNER_REVOKED');
      assert.deepEqual((await stored(root, job.id)).publication, originalIntent);
      assert.equal(fx.publications, 1);
    } finally {
      releaseReceipt.open();
      await hubA.waitForIdle(job.id);
    }
  }));

test('#22/#754: CORE revoke during independent final verification refuses authenticated stale receipt', async () =>
  temp(async root => {
    const verifying = gate(), releaseVerification = gate();
    const fx = mock('normal', {
      beforeFinalVerify: async () => {
        verifying.open();
        await releaseVerification.promise;
      },
    }, true);
    const hubA = fx.hub(root), hubB = fx.hub(root);
    const job = await hubA.start(input);
    try {
      await expectGate(verifying.promise, 'synthetic final receipt verifier');
      const before = await stored(root, job.id);
      assert.equal(before.state, 'PUBLISHING');
      assert.equal(before.bytesConfirmed, bytes.length);
      assert.equal(before.publication?.dispatched, true);
      assert.equal(before.publication?.sha256, digest(bytes));
      const intent = structuredClone(before.publication);
      assert.ok(intent?.requestId);
      assert.equal(fx.finalReceipts.length, 1);
      assert.equal(fx.finalReceipts[0]!.requestId, intent.requestId);
      assert.equal(fx.finalReceipts[0]!.epoch, intent.epoch);
      assert.equal(fx.finalReceipts[0]!.sha256, intent.sha256);
      assert.equal(fx.finalReceipts[0]!.jobId, job.id);
      assert.equal(fx.publications, 1);
      assert.equal(fx.publishedReceipts.length, 1);
      fx.grants.enabled = false;
      releaseVerification.open();
      await hubA.waitForIdle(job.id);
      const after = await stored(root, job.id);
      assert.equal(after.state, 'MUTATION_UNKNOWN');
      assert.equal(after.errorCode, 'CORE_OWNER_REVOKED');
      assert.deepEqual(after.publication, intent,
        'identity and dispatched bit remain durable despite verified stale receipt');
      assert.equal(after.bytesConfirmed, bytes.length);
      assert.equal(after.pending, undefined);
      assert.equal(fx.publications, 1);
      await assert.rejects(hubB.status(job.id, input.accountId,
        input.sourceDeviceId, input.targetDeviceId),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_OWNER_REVOKED');
      assert.equal((await stored(root, job.id)).state, 'MUTATION_UNKNOWN');
      assert.deepEqual((await stored(root, job.id)).publication, intent);
      assert.equal(fx.publications, 1);
    } finally {
      releaseVerification.open();
      await hubA.waitForIdle(job.id);
    }
  }));
