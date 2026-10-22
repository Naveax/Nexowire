import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CrossDeviceTransferJobs, type TransferJob, type TransferRemote }
  from '../src/mcp/cross-device-transfer-jobs.js';
import {
  TransferTrustError, type FencedFinalReceipt,
  type TrustedFinalReceiptVerifier, type TrustedTransferAuthority,
  type TrustedTransferCoreGrants, type TrustedPublicationCommit,
} from '../src/workspace/artifact-job-trust.js';
import type { AuthenticatedTransferRoute, TransferCheckpoint, TransferBinding }
  from '../src/mcp/cross-device-transfer-continuity.js';
import {
  inspectOneCallWorkerConnectionJournal, type FencedWorkerJournalSnapshot,
  type BrokerOwnerEpochAdmission,
} from '../src/mcp/cross-device-worker-journal-link.js';

/**
 * #21: exact #768 external commit and #770 read-only Connection observer
 * tested together. All signer keys, Native effects and external authority
 * are synthetic TEMP fixtures. NOT a deployed signed Agent, independent
 * anti-rollback backend or a physical production acceptance test.
 */
const bytes = Buffer.alloc(65_536 + 17, 0x6e);
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const req = {
  accountId: 'owner-21-verified', projectId: 'Nexowire',
  sourceDeviceId: 'source-qa21', targetDeviceId: 'target-qa21',
  sourcePath: '/synthetic/source-21', targetPath: '/synthetic/final-21',
};
type Mode = 'current' | 'revoke-before-external-commit' |
  'foreign-native-issuer' | 'lost-destination-readback';
type Ledger = {
  ownerEpoch: number; grantGeneration: number; sessionEpoch: string;
  committed?: {
    requestId: string; epoch: number; sha256: string; durableCommitId: string;
    issuer: string; ownerEpoch: number; grantGeneration: number;
  };
};
async function persist(file: string, value: unknown) {
  const f = await fs.open(file, 'w', 0o600);
  try { await f.writeFile(JSON.stringify(value)); await f.sync(); }
  finally { await f.close(); }
}
const jobRecord = async (root: string, id: string): Promise<TransferJob> =>
  JSON.parse(await fs.readFile(path.join(root, id + '.json'), 'utf8')) as TransferJob;
async function isolated(fn: (root: string, authorityFile: string) => Promise<void>) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nw-qa21-cas-issuer-'));
  try {
    const worker = path.join(temp, 'local-worker');
    const external = path.join(temp, 'separate-test-authority');
    await fs.mkdir(worker); await fs.mkdir(external);
    const file = path.join(external, 'monotonic-publications.json');
    await persist(file, { ownerEpoch: 71, grantGeneration: 9,
      sessionEpoch: randomUUID() } satisfies Ledger);
    await fn(worker, file);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
function rig(file: string, mode: Mode) {
  const issuer = 'synthetic-native-issuer-v1';
  const legitimateKey = randomBytes(32), untrustedKey = randomBytes(32);
  const initialEpoch = 71, initialGeneration = 9;
  let stage = Buffer.alloc(0), target: Buffer | undefined;
  let writes = 0, publishes = 0, verifies = 0, commitAttempts = 0;
  let receipt: FencedFinalReceipt | undefined;
  let entered!: () => void, release!: () => void;
  const atCommit = new Promise<void>(r => { entered = r; });
  const allowCommit = new Promise<void>(r => { release = r; });
  const ledger = async (): Promise<Ledger> =>
    JSON.parse(await fs.readFile(file, 'utf8')) as Ledger;
  const domain = (claims: Omit<FencedFinalReceipt, 'proof'>, owner: Ledger) =>
    JSON.stringify([issuer, owner.ownerEpoch, owner.grantGeneration,
      claims.requestId, claims.jobId, claims.accountId, claims.projectId,
      claims.targetDeviceId, claims.targetPath, claims.bytesTotal,
      claims.sha256, claims.epoch]);
  const mac = (claims: Omit<FencedFinalReceipt, 'proof'>, current: Ledger, key = legitimateKey) =>
    createHmac('sha256', key).update(domain(claims, current)).digest('hex');
  const matches = async (value: FencedFinalReceipt) => {
    const current = await ledger();
    if (current.ownerEpoch !== initialEpoch ||
        current.grantGeneration !== initialGeneration) return false;
    const { proof, ...claims } = value;
    if (!/^[0-9a-f]{64}$/.test(proof)) return false;
    return timingSafeEqual(Buffer.from(proof, 'hex'),
      Buffer.from(mac(claims, current), 'hex'));
  };
  const authority: TrustedTransferAuthority = {
    acquire: async () => ({
      epoch: 5, token: 'synthetic-only-worker-epoch-token-00000005',
    }),
    assertCurrent: async (_job, proof) => {
      const a = await ledger();
      if (proof.epoch !== 5 || a.ownerEpoch !== initialEpoch ||
          a.grantGeneration !== initialGeneration)
        throw new TransferTrustError('CORE_GRANT_EPOCH_STALE',
          'Rolled-back local worker is not the current external owner');
    },
    commitPublished: async (job, signed): Promise<TrustedPublicationCommit> => {
      commitAttempts++;
      // Deterministic barrier AFTER receipt+final target validation, at the
      // atomic external commit boundary (not merely a preceding precheck).
      if (mode === 'revoke-before-external-commit') {
        entered(); await allowCommit;
      }
      const a = await ledger();
      if (a.ownerEpoch !== initialEpoch || a.grantGeneration !== initialGeneration)
        throw new TransferTrustError('CORE_GRANT_EPOCH_STALE',
          'External monotonic owner advanced before publication CAS');
      if (!(await matches(signed)) || a.committed ||
          signed.jobId !== job.id || signed.sha256 !== job.sha256 ||
          signed.epoch !== job.fencing?.epoch || signed.accountId !== job.accountId ||
          signed.projectId !== job.projectId || signed.targetDeviceId !== job.targetDeviceId ||
          signed.targetPath !== job.targetPath || signed.bytesTotal !== job.bytesTotal ||
          signed.requestId !== receipt?.requestId)
        throw new TransferTrustError('EXTERNAL_PUBLICATION_COMMIT_INVALID',
          'Synthetic external single-use CAS rejected receipt, owner or issuer');
      const durableCommitId = 'synthetic-external-cas-commit-' + randomUUID();
      const committed: NonNullable<Ledger['committed']> = {
        requestId: signed.requestId, epoch: signed.epoch, sha256: signed.sha256,
        durableCommitId, issuer, ownerEpoch: a.ownerEpoch,
        grantGeneration: a.grantGeneration,
      };
      await persist(file, { ...a, committed } satisfies Ledger);
      return { jobId: job.id, requestId: signed.requestId,
        epoch: signed.epoch, sha256: signed.sha256, durableCommitId };
    },
  };
  const grants: TrustedTransferCoreGrants = {
    assertCurrent: async j => {
      const a = await ledger();
      if (j.accountId !== req.accountId || j.projectId !== req.projectId ||
          a.ownerEpoch !== initialEpoch || a.grantGeneration !== initialGeneration)
        throw new TransferTrustError('CORE_GRANT_EPOCH_STALE',
          'Protected owner grant changed; stale journal is not authority');
    },
  };
  const verifier: TrustedFinalReceiptVerifier = {
    verify: async (_job, signed) => {
      verifies++;
      return matches(signed);
    },
  };
  const remote: TransferRemote = {
    stat: async (dev, filename) => {
      const data = dev === req.sourceDeviceId ? bytes :
        filename === req.targetPath ? target : stage;
      if (!data) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
      return { type: 'file', size: data.length };
    },
    hash: async (dev, filename) => {
      if (mode === 'lost-destination-readback' &&
          dev === req.targetDeviceId && filename === req.targetPath)
        throw Error('SIMULATED_INDEPENDENT_FINAL_READBACK_UNAVAILABLE');
      const data = dev === req.sourceDeviceId ? bytes :
        filename === req.targetPath ? target : stage;
      if (!data) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
      return digest(data);
    },
    read: async (_dev, _p, off, size) => {
      const chunk = bytes.subarray(off, off + size);
      return { sourceBytes: bytes.length, offsetBytes: off,
        bytesRead: chunk.length, contentBase64: chunk.toString('base64') };
    },
    write: async () => { throw Error('UNFENCED_WRITE_PROHIBITED'); },
    moveNoOverwrite: async () => { throw Error('UNFENCED_PUBLISH_PROHIBITED'); },
    writeFenced: async (_j, env, encoded, first) => {
      const chunk = Buffer.from(encoded, 'base64');
      assert.equal(first, stage.length === 0);
      assert.equal(env.offset, stage.length);
      assert.equal(env.sha256, digest(chunk));
      stage = Buffer.concat([stage, chunk]); writes++;
      return { requestId: env.requestId, epoch: env.epoch,
        offset: env.offset, length: env.length, sha256: env.sha256 };
    },
    publishFenced: async (job, epoch, _token, requestId) => {
      assert.ok(requestId);
      assert.equal(target, undefined, 'Native publication must NEVER be replayed');
      target = Buffer.from(stage); publishes++;
      const a = await ledger();
      const claims: Omit<FencedFinalReceipt, 'proof'> = {
        requestId, jobId: job.id, accountId: job.accountId,
        projectId: job.projectId, targetDeviceId: job.targetDeviceId,
        targetPath: job.targetPath, bytesTotal: job.bytesTotal,
        sha256: job.sha256, epoch,
      };
      receipt = { ...claims, proof: mac(claims, a,
        mode === 'foreign-native-issuer' ? untrustedKey : legitimateKey) };
      return receipt;
    },
  };
  const hub = (dir: string) => new CrossDeviceTransferJobs(dir, remote, {
    requireExternalAuthority: true, authority, grants,
    requireAuthenticatedFinalReceipt: true, finalReceiptVerifier: verifier,
  });
  const admission: BrokerOwnerEpochAdmission = {
    ownerEpoch: initialEpoch, grantGeneration: initialGeneration,
    deviceEpoch: randomUUID(), sessionEpoch: randomUUID(), privilege: 'CORE',
  };
  const observe = async (worker: TransferJob) => {
    const binding: TransferBinding = {
      jobId: worker.id, ownerId: worker.accountId, projectId: worker.projectId,
      sourceDeviceId: worker.sourceDeviceId,
      destinationDeviceId: worker.targetDeviceId, sourcePath: worker.sourcePath,
      targetPath: worker.targetPath, stagePath: worker.stagePath,
      sourceSha256: worker.sha256, totalBytes: worker.bytesTotal,
    };
    const route: AuthenticatedTransferRoute = {
      ownerId: worker.accountId, projectId: worker.projectId,
      sourceDeviceId: worker.sourceDeviceId, destinationDeviceId: worker.targetDeviceId,
      epoch: 9,
    };
    const checkpoint: TransferCheckpoint = {
      binding, revision: 4, epoch: 9, offset: worker.bytesTotal, status: 'ready',
    };
    return inspectOneCallWorkerConnectionJournal({
      worker: worker as FencedWorkerJournalSnapshot, checkpoint, route, ownerAdmission: admission,
      authorize: async () => true,
      workerLease: { check: async () => true },
      ownerEpochWitness: {
        assertFresh: async c => {
          const now = await ledger();
          return c.ownerId === req.accountId && c.deviceId === req.targetDeviceId &&
            c.ownerEpoch === now.ownerEpoch && c.grantGeneration === now.grantGeneration &&
            c.ownerEpoch === admission.ownerEpoch &&
            c.grantGeneration === admission.grantGeneration &&
            /^[0-9a-f]{64}$/.test(c.challengeNonce);
        },
      },
      sessionWitness: { currentEpoch: async () => 9 },
      publicationReceiptReadback: {
        inspect: async () => receipt && await matches(receipt) ?
          { kind: 'verified' as const, receipt } : { kind: 'invalid' as const },
      },
      publishedTargetReadback: {
        inspect: async w => target ?
          { kind: 'verified' as const, deviceId: w.targetDeviceId,
            targetPath: w.targetPath, bytesTotal: target.length,
            sha256: digest(target) } : { kind: 'unavailable' as const },
      },
    });
  };
  return { hub, ledger, observe, atCommit, release: () => release(),
    revoke: async () => {
      const old = await ledger();
      await persist(file, { ...old, ownerEpoch: old.ownerEpoch + 1,
        grantGeneration: old.grantGeneration + 1,
        sessionEpoch: randomUUID() } satisfies Ledger);
    },
    get publishes() { return publishes; }, get writes() { return writes; },
    get verifies() { return verifies; }, get commitAttempts() { return commitAttempts; },
    get receipt() { return receipt; }, get target() { return target; },
  };
}

test('#21 #768+#770: authenticated final receipt + actual external CAS commit precedes COMPLETED',
  { timeout: 20_000 }, async () => isolated(async (root, authorityFile) => {
    const f = rig(authorityFile, 'current'), a = f.hub(root);
    const started = await a.start(req);
    await a.waitForIdle(started.id);
    const done = await jobRecord(root, started.id);
    const external = await f.ledger();
    assert.equal(done.state, 'COMPLETED');
    assert.equal(done.publication?.dispatched, true);
    assert.equal(f.verifies, 1);
    assert.equal(f.commitAttempts, 1);
    assert.equal(f.publishes, 1);
    assert.equal(external.committed?.requestId, done.publication?.requestId);
    assert.equal(external.committed?.sha256, digest(bytes));
    assert.equal(external.committed?.ownerEpoch, 71);
    assert.equal(external.committed?.grantGeneration, 9);
    assert.equal(external.committed?.durableCommitId, done.publication?.durableCommitId);
    assert.ok((done.publication?.durableCommitId?.length ?? 0) >= 32);
    // #770 is a READ-ONLY observer. Even authentic issuer + verified target
    // must NOT be mistaken for a second external commit or replay permit.
    const observation = await f.observe(done);
    assert.equal(observation.state, 'publication_verified_not_committed');
    assert.equal(observation.checkpointAdvanced, false);
    assert.equal(observation.automaticallyReplayable, false);
    assert.equal(observation.externalSideEffectProven, false);
    assert.equal(f.commitAttempts, 1);
    assert.equal(f.publishes, 1);
  }));

test('#21 #768+#770: owner revoked DURING external final CAS, old receipt plus local rollback stays UNKNOWN',
  { timeout: 20_000 }, async () => isolated(async (root, authorityFile) => {
    const f = rig(authorityFile, 'revoke-before-external-commit'), a = f.hub(root);
    const started = await a.start(req);
    const localFile = path.join(root, started.id + '.json');
    let rollbackSnapshot = '';
    try {
      await f.atCommit;
      const before = await jobRecord(root, started.id);
      assert.equal(before.state, 'PUBLISHING');
      assert.equal(before.publication?.dispatched, true);
      assert.equal(f.commitAttempts, 1);
      assert.equal(f.publishes, 1);
      assert.equal((await f.observe(before)).state, 'publication_verified_not_committed',
        'signed issuer plus destination bytes is only an observation');
      rollbackSnapshot = await fs.readFile(localFile, 'utf8');
      await f.revoke(); // separate fsynced external high-water survives local rollback
    } finally { f.release(); await a.waitForIdle(started.id); }
    const after = await jobRecord(root, started.id);
    assert.equal(after.state, 'MUTATION_UNKNOWN');
    assert.equal(after.errorCode, 'CORE_GRANT_EPOCH_STALE');
    assert.equal(after.publication?.dispatched, true);
    assert.equal(after.publication?.durableCommitId, undefined);
    assert.equal(after.publication?.sha256, digest(bytes));
    assert.equal((await f.ledger()).committed, undefined);
    assert.equal((await f.observe(after)).state, 'authority_blocked');
    assert.equal(f.publishes, 1);

    // Old local WAL cannot roll back independently held owner/grant epoch.
    await persist(localFile, rollbackSnapshot);
    const oldJournal = await jobRecord(root, started.id);
    assert.equal(oldJournal.state, 'PUBLISHING');
    assert.equal(oldJournal.publication?.requestId, after.publication?.requestId);
    const b = f.hub(root);
    await assert.rejects(b.status(started.id, req.accountId,
      req.sourceDeviceId, req.targetDeviceId),
    (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_GRANT_EPOCH_STALE');
    await assert.rejects(b.start({ ...req, resumeTransferId: started.id }),
    (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_GRANT_EPOCH_STALE');
    assert.equal(f.commitAttempts, 1);
    assert.equal(f.publishes, 1);
    assert.equal((await f.ledger()).committed, undefined);
  }));

test('#21 #768+#770: FOREIGN cryptographic final issuer with correct requestId and SHA cannot commit',
  { timeout: 15_000 }, async () => isolated(async (root, authorityFile) => {
    const f = rig(authorityFile, 'foreign-native-issuer'), a = f.hub(root);
    const started = await a.start(req);
    await a.waitForIdle(started.id);
    const failed = await jobRecord(root, started.id);
    assert.equal(failed.state, 'MUTATION_UNKNOWN');
    assert.equal(failed.errorCode, 'FINAL_RECEIPT_UNAUTHENTICATED');
    assert.equal(failed.publication?.dispatched, true);
    assert.equal(failed.publication?.requestId, f.receipt?.requestId);
    assert.equal(failed.publication?.sha256, digest(bytes));
    assert.equal(failed.publication?.durableCommitId, undefined);
    assert.equal(f.commitAttempts, 0);
    assert.equal((await f.ledger()).committed, undefined);
    assert.equal((await f.observe(failed)).state, 'mutation_unknown');
    const b = f.hub(root);
    assert.equal((await b.cancel(started.id, req.accountId,
      req.sourceDeviceId, req.targetDeviceId)).state, 'MUTATION_UNKNOWN');
    assert.equal(f.publishes, 1);
    assert.equal(f.writes, 2);
  }));

test('#21 #768+#770: lost independently readable final target effect means UNKNOWN, never CAS or replay',
  { timeout: 15_000 }, async () => isolated(async (root, authorityFile) => {
    const f = rig(authorityFile, 'lost-destination-readback'), a = f.hub(root);
    const started = await a.start(req);
    await a.waitForIdle(started.id);
    const failed = await jobRecord(root, started.id);
    assert.equal(failed.state, 'MUTATION_UNKNOWN');
    assert.equal(failed.publication?.dispatched, true);
    assert.equal(failed.publication?.durableCommitId, undefined);
    assert.equal(failed.publication?.requestId, f.receipt?.requestId);
    assert.equal(f.verifies, 1);
    assert.equal(f.commitAttempts, 0);
    assert.equal((await f.ledger()).committed, undefined);
    assert.equal(f.publishes, 1);
    assert.equal((await f.observe(failed)).state, 'mutation_unknown');
    const b = f.hub(root);
    assert.equal((await b.cancel(started.id, req.accountId,
      req.sourceDeviceId, req.targetDeviceId)).state, 'MUTATION_UNKNOWN');
    assert.equal((await jobRecord(root, started.id)).publication?.requestId,
      failed.publication?.requestId);
    assert.equal(f.publishes, 1, 'the possibly completed Native effect must never be replayed');
  }));
