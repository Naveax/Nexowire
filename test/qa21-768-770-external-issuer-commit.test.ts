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
  'foreign-native-issuer' | 'lost-destination-readback' |
  'forged-second-write-ack' | 'owner-revoked-during-final-verification' |
  'correctly-signed-foreign-final-sha' | 'forged-second-write-ack-cancel-race';
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
  let finalHashReadbacks = 0;
  let receipt: FencedFinalReceipt | undefined;
  let entered!: () => void, release!: () => void;
  const atCommit = new Promise<void>(r => { entered = r; });
  const allowCommit = new Promise<void>(r => { release = r; });
  let enteredVerifier!: () => void, releaseVerifier!: () => void;
  const atVerifier = new Promise<void>(r => { enteredVerifier = r; });
  const allowVerifier = new Promise<void>(r => { releaseVerifier = r; });
  let enteredSecondWrite!: () => void, releaseSecondWrite!: () => void;
  const atSecondWrite = new Promise<void>(r => { enteredSecondWrite = r; });
  const allowSecondWrite = new Promise<void>(r => { releaseSecondWrite = r; });
  const ledger = async (): Promise<Ledger> =>
    JSON.parse(await fs.readFile(file, 'utf8')) as Ledger;
  const domain = (claims: Omit<FencedFinalReceipt, 'proof'>, owner: Ledger) =>
    JSON.stringify([issuer, owner.ownerEpoch, owner.grantGeneration,
      claims.requestId, claims.jobId, claims.accountId, claims.projectId,
      claims.targetDeviceId, claims.targetPath, claims.bytesTotal,
      claims.sha256, claims.epoch]);
  const mac = (claims: Omit<FencedFinalReceipt, 'proof'>, current: Ledger, key = legitimateKey) =>
    createHmac('sha256', key).update(domain(claims, current)).digest('hex');
  const authenticateIssuedReceipt = (value: FencedFinalReceipt) => {
    // Cryptographic issuer authenticity is distinct from a FRESH owner
    // epoch. A valid old receipt MUST NOT resurrect a revoked CORE grant.
    const { proof, ...claims } = value;
    if (!/^[0-9a-f]{64}$/.test(proof)) return false;
    const issuance: Ledger = {
      ownerEpoch: initialEpoch, grantGeneration: initialGeneration,
      sessionEpoch: 'issue-time-authenticated-session',
    };
    return timingSafeEqual(Buffer.from(proof, 'hex'),
      Buffer.from(mac(claims, issuance), 'hex'));
  };
  const matches = async (value: FencedFinalReceipt) => {
    const current = await ledger();
    return current.ownerEpoch === initialEpoch &&
      current.grantGeneration === initialGeneration &&
      authenticateIssuedReceipt(value);
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
      if (mode === 'owner-revoked-during-final-verification') {
        // Pause AFTER a real synthetic Native final side effect and a
        // correctly HMAC-signed receipt; change external owner authority
        // during this await, not before publication dispatch.
        enteredVerifier();
        await allowVerifier;
        return authenticateIssuedReceipt(signed);
      }
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
      if (dev === req.targetDeviceId && filename === req.targetPath)
        finalHashReadbacks++;
      if (mode === 'lost-destination-readback' &&
          dev === req.targetDeviceId && filename === req.targetPath)
        throw Error('SIMULATED_INDEPENDENT_FINAL_READBACK_UNAVAILABLE');
      const data = dev === req.sourceDeviceId ? bytes :
        filename === req.targetPath ? target : stage;
      if (!data) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
      return digest(data);
    },
    read: async (dev, _p, off, size) => {
      // Target-stage readback must report STAGE length, not source file size.
      // Otherwise this negative never reaches its intended publication gate.
      const full = dev === req.sourceDeviceId ? bytes : stage;
      const chunk = full.subarray(off, off + size);
      return { sourceBytes: full.length, offsetBytes: off,
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
      if (mode === 'forged-second-write-ack-cancel-race' && env.offset === 65_536) {
        // Actual synthetic Native mutation is already applied. Another Hub
        // cancels while its (forged) receipt is in flight. No timing sleeps.
        enteredSecondWrite();
        await allowSecondWrite;
      }
      return {
        // The second Native mutation may have happened, but this signed-
        // looking ACK must NOT be credited to its immutable pending intent.
        requestId: (mode === 'forged-second-write-ack' ||
          mode === 'forged-second-write-ack-cancel-race') && env.offset === 65_536
          ? randomUUID() : env.requestId,
        epoch: env.epoch, offset: env.offset,
        length: env.length, sha256: env.sha256,
      };
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
        sha256: mode === 'correctly-signed-foreign-final-sha'
          ? '0'.repeat(64) : job.sha256,
        epoch,
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
  return {
    hub, ledger, observe, atCommit, release: () => release(),
    atVerifier, releaseVerifier: () => releaseVerifier(),
    atSecondWrite, releaseSecondWrite: () => releaseSecondWrite(),
    authenticateIssuedReceipt,
    revoke: async () => {
      const old = await ledger();
      await persist(file, { ...old, ownerEpoch: old.ownerEpoch + 1,
        grantGeneration: old.grantGeneration + 1,
        sessionEpoch: randomUUID() } satisfies Ledger);
    },
    get publishes() { return publishes; }, get writes() { return writes; },
    get verifies() { return verifies; }, get commitAttempts() { return commitAttempts; },
    get finalHashReadbacks() { return finalHashReadbacks; },
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
    // persist() serializes its argument; restore the parsed JSON object,
    // never double-encode the captured journal JSON string.
    await persist(localFile, JSON.parse(rollbackSnapshot) as TransferJob);
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


test('#21 #768+#770: forged second Native chunk ACK keeps dispatched UNKNOWN and never starts final CAS',
  { timeout: 15_000 }, async () => isolated(async (root, authorityFile) => {
    const f = rig(authorityFile, 'forged-second-write-ack'), firstHub = f.hub(root);
    const started = await firstHub.start(req);
    await firstHub.waitForIdle(started.id);
    const unknown = await jobRecord(root, started.id);
    assert.equal(unknown.state, 'MUTATION_UNKNOWN');
    assert.equal(unknown.errorCode, 'FORGED_WRITE_RECEIPT');
    assert.equal(unknown.bytesConfirmed, 65_536, 'forged second ACK must not be credited');
    assert.equal(unknown.pending?.offset, 65_536);
    assert.equal(unknown.pending?.length, bytes.length - 65_536);
    assert.equal(unknown.pending?.dispatched, true);
    assert.equal(unknown.pending?.sha256, digest(bytes.subarray(65_536)));
    assert.equal(unknown.sha256, digest(bytes), 'forged ACK never modifies original full SHA');
    assert.equal(unknown.pending?.epoch, unknown.fencing?.epoch);
    assert.ok(unknown.pending?.requestId);
    assert.equal(unknown.publication, undefined, 'no final request may be reserved');
    assert.equal(f.writes, 2, 'both Native chunk effects were simulated exactly once');
    assert.equal(f.publishes, 0);
    assert.equal(f.verifies, 0);
    assert.equal(f.commitAttempts, 0);
    assert.equal((await f.ledger()).committed, undefined);
    const secondHub = f.hub(root);
    assert.equal((await secondHub.cancel(started.id, req.accountId,
      req.sourceDeviceId, req.targetDeviceId)).state, 'MUTATION_UNKNOWN');
    const preserved = await jobRecord(root, started.id);
    assert.equal(preserved.errorCode, 'FORGED_WRITE_RECEIPT');
    assert.equal(preserved.pending?.requestId, unknown.pending?.requestId);
    assert.equal(preserved.pending?.sha256, unknown.pending?.sha256);
    assert.equal(f.writes, 2, 'another Hub must not replay the unknown side effect');
    assert.equal(f.publishes, 0);
    assert.equal(f.commitAttempts, 0);
  }));


test('#21 CAS-aware #762: signed final receipt remains authentic but owner revoke during verifier forbids completion and replay',
  { timeout: 20_000 }, async () => isolated(async (root, authorityFile) => {
    const fx = rig(authorityFile, 'owner-revoked-during-final-verification');
    const firstHub = fx.hub(root);
    const started = await firstHub.start(req);
    const filename = path.join(root, started.id + '.json');
    let snapshot: TransferJob | undefined;
    try {
      await fx.atVerifier;
      const publishing = await jobRecord(root, started.id);
      assert.equal(publishing.state, 'PUBLISHING');
      assert.equal(publishing.publication?.dispatched, true);
      assert.equal(publishing.publication?.epoch, 5);
      assert.equal(publishing.publication?.sha256, digest(bytes));
      assert.equal(publishing.bytesConfirmed, bytes.length);
      assert.ok(fx.receipt);
      assert.equal(fx.receipt?.requestId, publishing.publication?.requestId);
      assert.equal(fx.authenticateIssuedReceipt(fx.receipt!), true,
        'Native receipt MAC remains cryptographically authentic at issue time');
      assert.equal(fx.publishes, 1, 'synthetic destination mutation already occurred');
      assert.deepEqual(fx.target, bytes);
      snapshot = structuredClone(publishing);
      await fx.revoke();
    } finally {
      fx.releaseVerifier();
      await firstHub.waitForIdle(started.id);
    }
    const unknown = await jobRecord(root, started.id);
    assert.equal(unknown.state, 'MUTATION_UNKNOWN');
    assert.equal(unknown.errorCode, 'CORE_GRANT_EPOCH_STALE');
    assert.equal(unknown.bytesConfirmed, bytes.length);
    assert.equal(unknown.publication?.dispatched, true);
    assert.equal(unknown.publication?.requestId, snapshot?.publication?.requestId);
    assert.equal(unknown.publication?.sha256, digest(bytes));
    assert.equal(unknown.publication?.durableCommitId, undefined);
    assert.equal(fx.verifies, 1);
    assert.equal(fx.finalHashReadbacks, 0, 'owner revoked before final destination credit');
    assert.equal(fx.commitAttempts, 0);
    assert.equal((await fx.ledger()).committed, undefined);
    assert.equal(fx.writes, 2);
    assert.equal(fx.publishes, 1);

    // Restore ONLY the rollbackable local worker journal. External owner
    // high-water remains revoked, so a second Hub must not resume/publish.
    assert.ok(snapshot);
    await persist(filename, snapshot);
    const reopened = await jobRecord(root, started.id);
    assert.equal(reopened.state, 'PUBLISHING');
    assert.equal(reopened.publication?.requestId, unknown.publication?.requestId);
    const secondHub = fx.hub(root);
    await assert.rejects(secondHub.start({ ...req, resumeTransferId: started.id }),
      (e: unknown) => e instanceof TransferTrustError &&
        e.code === 'CORE_GRANT_EPOCH_STALE');
    await assert.rejects(secondHub.status(started.id,
      req.accountId, req.sourceDeviceId, req.targetDeviceId),
      (e: unknown) => e instanceof TransferTrustError &&
        e.code === 'CORE_GRANT_EPOCH_STALE');
    assert.equal(fx.publishes, 1);
    assert.equal(fx.commitAttempts, 0);
    assert.equal((await fx.ledger()).committed, undefined);
  }));

test('#21 CAS-aware #762: authentically signed FOREIGN final SHA preserves immutable publication and UNKNOWN',
  { timeout: 15_000 }, async () => isolated(async (root, authorityFile) => {
    const fx = rig(authorityFile, 'correctly-signed-foreign-final-sha');
    const firstHub = fx.hub(root);
    const started = await firstHub.start(req);
    await firstHub.waitForIdle(started.id);
    const result = await jobRecord(root, started.id);
    assert.ok(fx.receipt);
    assert.equal(fx.authenticateIssuedReceipt(fx.receipt!), true,
      'this is a valid HMAC over the WRONG immutable full SHA, not a bad MAC');
    assert.equal(fx.receipt?.requestId, result.publication?.requestId);
    assert.equal(fx.receipt?.sha256, '0'.repeat(64));
    assert.equal(result.sha256, digest(bytes));
    assert.equal(result.publication?.sha256, digest(bytes),
      'journal original full SHA cannot be replaced by the foreign receipt');
    assert.equal(result.state, 'MUTATION_UNKNOWN');
    assert.equal(result.errorCode, 'FINAL_RECEIPT_MISMATCH');
    assert.equal(result.bytesConfirmed, bytes.length);
    assert.equal(result.publication?.dispatched, true);
    assert.equal(result.publication?.durableCommitId, undefined);
    assert.deepEqual(fx.target, bytes, 'Native synthetic side effect occurred');
    assert.equal(fx.verifies, 0, 'immutable SHA mismatch precedes MAC verifier');
    assert.equal(fx.finalHashReadbacks, 0);
    assert.equal(fx.commitAttempts, 0);
    assert.equal((await fx.ledger()).committed, undefined);
    assert.equal(fx.publishes, 1);

    const secondHub = fx.hub(root);
    const afterCancel = await secondHub.cancel(started.id,
      req.accountId, req.sourceDeviceId, req.targetDeviceId);
    assert.equal(afterCancel.state, 'MUTATION_UNKNOWN');
    const retained = await jobRecord(root, started.id);
    assert.equal(retained.errorCode, 'FINAL_RECEIPT_MISMATCH');
    assert.equal(retained.publication?.requestId, result.publication?.requestId);
    assert.equal(retained.publication?.sha256, result.publication?.sha256);
    assert.equal(fx.writes, 2);
    assert.equal(fx.publishes, 1, 'no second Native publication permitted');
    assert.equal(fx.commitAttempts, 0);
  }));


test('#21 final ACK QA: concurrent cancel AFTER second Native write preserves forged requestId cause, UNKNOWN, no CAS',
  { timeout: 20_000 }, async () => isolated(async (root, authorityFile) => {
    const fx = rig(authorityFile, 'forged-second-write-ack-cancel-race');
    const firstHub = fx.hub(root), secondHub = fx.hub(root);
    const started = await firstHub.start(req);
    let originalPending: NonNullable<TransferJob['pending']> | undefined;
    try {
      // Promise barrier is reached only AFTER 64KiB verified and the second
      // Native stage mutation applied. No fixed millisecond scheduling.
      await fx.atSecondWrite;
      const beforeCancel = await jobRecord(root, started.id);
      assert.equal(beforeCancel.state, 'RUNNING');
      assert.equal(beforeCancel.bytesConfirmed, 65_536);
      assert.equal(beforeCancel.pending?.offset, 65_536);
      assert.equal(beforeCancel.pending?.length, bytes.length - 65_536);
      assert.equal(beforeCancel.pending?.dispatched, true);
      assert.equal(beforeCancel.pending?.epoch, beforeCancel.fencing?.epoch);
      assert.equal(beforeCancel.pending?.sha256, digest(bytes.subarray(65_536)));
      assert.ok(beforeCancel.pending?.requestId);
      originalPending = structuredClone(beforeCancel.pending);
      assert.equal(fx.writes, 2, 'the second Native side effect has happened');
      assert.equal(fx.publishes, 0);
      assert.equal(fx.commitAttempts, 0);

      const response = await secondHub.cancel(started.id, req.accountId,
        req.sourceDeviceId, req.targetDeviceId);
      assert.equal(response.state, 'CANCEL_REQUESTED',
        'other Hub records cancel but cannot call a real dispatched mutation no-effect');
      const pendingCancel = await jobRecord(root, started.id);
      assert.equal(pendingCancel.pending?.requestId, originalPending?.requestId);
      assert.equal(pendingCancel.pending?.dispatched, true);
    } finally {
      fx.releaseSecondWrite();
      await firstHub.waitForIdle(started.id);
    }
    const final = await jobRecord(root, started.id);
    assert.equal(final.state, 'MUTATION_UNKNOWN', 'post-effect cancellation never clean CANCELLED');
    assert.equal(final.errorCode, 'FORGED_WRITE_RECEIPT',
      'precise forged Native ACK takes precedence over generic cancel marker');
    assert.equal(final.bytesConfirmed, 65_536);
    assert.equal(final.sha256, digest(bytes), 'original immutable full source SHA retained');
    assert.equal(final.pending?.requestId, originalPending?.requestId);
    assert.equal(final.pending?.sha256, originalPending?.sha256);
    assert.equal(final.pending?.offset, originalPending?.offset);
    assert.equal(final.pending?.epoch, originalPending?.epoch);
    assert.equal(final.pending?.dispatched, true);
    assert.equal(final.publication, undefined);
    assert.equal(fx.verifies, 0);
    assert.equal(fx.publishes, 0);
    assert.equal(fx.commitAttempts, 0);
    assert.equal((await fx.ledger()).committed, undefined);

    const laterCancel = await secondHub.cancel(started.id, req.accountId,
      req.sourceDeviceId, req.targetDeviceId);
    assert.equal(laterCancel.state, 'MUTATION_UNKNOWN');
    const retained = await jobRecord(root, started.id);
    assert.equal(retained.errorCode, 'FORGED_WRITE_RECEIPT');
    assert.equal(retained.pending?.requestId, originalPending?.requestId);
    assert.equal(fx.writes, 2, 'reopened cancellation cannot replay either write');
    assert.equal(fx.publishes, 0);
    assert.equal(fx.commitAttempts, 0);
  }));
