import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CrossDeviceTransferJobs, type TransferJob, type TransferRemote }
  from '../src/mcp/cross-device-transfer-jobs.js';
import { TransferTrustError, type FencedFinalReceipt, type TrustedFinalReceiptVerifier,
  type TrustedTransferAuthority, type TrustedTransferCoreGrants }
  from '../src/workspace/artifact-job-trust.js';

/**
 * #21 independent QA for #754 final receipt, cross-reviewing #751/#742
 * (local rollback vs independent owner epoch) and #708 stale-Hub publish.
 * Native publisher, HMAC, epoch store, and target are SYNTHETIC. This is
 * NOT a deployed Agent signer, physical rollback-resistant CAS or real IO.
 * The only filesystem operations are disposable TEMP journal fixtures.
 */
const CHUNK = 65_536;
const source = Buffer.alloc(CHUNK + 23);
for (let i = 0; i < source.length; i++) source[i] = (i * 19 + 43) & 0xff;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const input = {
  accountId: 'owner:qa21-final', projectId: 'Nexowire',
  sourceDeviceId: 'source-qa21', targetDeviceId: 'destination-qa21',
  sourcePath: '/synthetic/source', targetPath: '/synthetic/final',
};
type Mode = 'revoke-during-valid-final-receipt' |
  'signed-but-wrong-final-sha' | 'forged-second-chunk-write-ack';
const externalEpoch = { ownerEpoch: 41, grantGeneration: 17, deviceEpoch: 'device-epoch-current' };

async function persist(filename: string, content: string) {
  const fd = await fs.open(filename, 'w', 0o600);
  try { await fd.writeFile(content); await fd.sync(); }
  finally { await fd.close(); }
}
async function readJournal(root: string, id: string): Promise<TransferJob> {
  return JSON.parse(await fs.readFile(path.join(root, id + '.json'), 'utf8')) as TransferJob;
}
async function isolated(testCase: (root: string, ownerFile: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nex-qa21-final-'));
  try {
    // The owner epoch is deliberately OUTSIDE the rollbackable worker dir.
    const ownerDir = path.join(root, 'outside-worker-journal');
    const workerDir = path.join(root, 'worker-journal');
    await fs.mkdir(ownerDir); await fs.mkdir(workerDir);
    const ownerFile = path.join(ownerDir, 'owner-epoch.json');
    await persist(ownerFile, JSON.stringify(externalEpoch));
    await testCase(workerDir, ownerFile);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
function fixture(ownerFile: string, mode: Mode) {
  const protectedTestKey = randomBytes(32); // never included in the worker journal
  let stage = Buffer.alloc(0);
  let target: Buffer | undefined;
  let writeCalls = 0, publishCalls = 0, verifiedCalls = 0, targetHashCalls = 0;
  let finalReceipt: FencedFinalReceipt | undefined;
  let atVerification!: () => void, continueVerification!: () => void;
  const verificationEntered = new Promise<void>(resolve => { atVerification = resolve; });
  const verificationReleased = new Promise<void>(resolve => { continueVerification = resolve; });
  const sign = (claims: Omit<FencedFinalReceipt, 'proof'>) =>
    createHmac('sha256', protectedTestKey).update(JSON.stringify(claims)).digest('hex');
  const verifyMac = (receipt: FencedFinalReceipt) => {
    const { proof, ...claims } = receipt;
    return sign(claims) === proof;
  };
  const authority: TrustedTransferAuthority = {
    acquire: async () => ({ epoch: 3, token: 'SYNTHETIC-NATIVE-EPOCH-TOKEN-ONLY-0000000003' }),
    assertCurrent: async (_job, lease) => {
      if (lease.epoch !== 3) throw new TransferTrustError('NATIVE_STALE_EPOCH',
        'Fixture worker lease does not match protected external epoch');
    },
  };
  const grants: TrustedTransferCoreGrants = {
    assertCurrent: async job => {
      const fresh = JSON.parse(await fs.readFile(ownerFile, 'utf8')) as typeof externalEpoch;
      if (job.accountId !== input.accountId || job.projectId !== input.projectId ||
          fresh.ownerEpoch !== externalEpoch.ownerEpoch ||
          fresh.grantGeneration !== externalEpoch.grantGeneration ||
          fresh.deviceEpoch !== externalEpoch.deviceEpoch) {
        throw new TransferTrustError('CORE_GRANT_EPOCH_STALE',
          'Rolled-back local journal cannot restore current external owner/grant epoch');
      }
    },
  };
  const verifier: TrustedFinalReceiptVerifier = {
    verify: async (_job, receipt) => {
      verifiedCalls++;
      if (mode === 'revoke-during-valid-final-receipt') {
        atVerification();
        await verificationReleased;
      }
      return verifyMac(receipt);
    },
  };
  const remote: TransferRemote = {
    stat: async (device, file) => {
      const content = device === input.sourceDeviceId ? source :
        file === input.targetPath ? target : stage;
      if (content === undefined) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
      return { type: 'file', size: content.length };
    },
    hash: async (device, file) => {
      if (device === input.targetDeviceId && file === input.targetPath) targetHashCalls++;
      const content = device === input.sourceDeviceId ? source :
        file === input.targetPath ? target : stage;
      if (content === undefined) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
      return sha256(content);
    },
    read: async (device, _file, offset, length) => {
      const full = device === input.sourceDeviceId ? source : stage;
      const chunk = full.subarray(offset, offset + length);
      return {
        sourceBytes: full.length, offsetBytes: offset, bytesRead: chunk.length,
        contentBase64: chunk.toString('base64'),
      };
    },
    write: async () => { throw Error('NEVER_ALLOW_UNFENCED_WRITE'); },
    moveNoOverwrite: async () => { throw Error('NEVER_ALLOW_UNFENCED_PUBLISH'); },
    writeFenced: async (_job, env, body, first) => {
      const chunk = Buffer.from(body, 'base64');
      assert.equal(env.offset, stage.length);
      assert.equal(env.length, chunk.length);
      assert.equal(env.sha256, sha256(chunk));
      assert.equal(first, stage.length === 0);
      stage = Buffer.concat([stage, chunk]);
      writeCalls++;
      return {
        requestId: mode === 'forged-second-chunk-write-ack' && env.offset === CHUNK
          ? randomUUID() : env.requestId,
        epoch: env.epoch, offset: env.offset, length: env.length, sha256: env.sha256,
      };
    },
    publishFenced: async (job, epoch, _token, requestId) => {
      publishCalls++;
      assert.ok(requestId, 'Native publish receives the durable requestId');
      assert.equal(target, undefined, 'publication must be executed at most once');
      target = Buffer.from(stage); // synthetic mutation occurred
      const claims: Omit<FencedFinalReceipt, 'proof'> = {
        requestId, jobId: job.id, accountId: job.accountId, projectId: job.projectId,
        targetDeviceId: job.targetDeviceId, targetPath: job.targetPath,
        bytesTotal: job.bytesTotal,
        sha256: mode === 'signed-but-wrong-final-sha' ? '0'.repeat(64) : job.sha256,
        epoch,
      };
      finalReceipt = { ...claims, proof: sign(claims) };
      return finalReceipt;
    },
  };
  const jobs = (root: string) => new CrossDeviceTransferJobs(root, remote, {
    requireExternalAuthority: true, authority, grants,
    requireAuthenticatedFinalReceipt: true, finalReceiptVerifier: verifier,
  });
  return {
    jobs, verificationEntered, release: () => continueVerification(),
    authentic: () => finalReceipt !== undefined && verifyMac(finalReceipt),
    get receipt() { return finalReceipt; },
    get writes() { return writeCalls; }, get publishes() { return publishCalls; },
    get verifications() { return verifiedCalls; },
    get finalReadbackHashes() { return targetHashCalls; },
    get staged() { return stage; }, get target() { return target; },
  };
}

test('#21 rollback: valid final signed receipt cannot complete after independent owner epoch advances during verification',
  { timeout: 20_000 }, async () => isolated(async (root, ownerFile) => {
    const fx = fixture(ownerFile, 'revoke-during-valid-final-receipt');
    const owner = fx.jobs(root);
    const start = await owner.start(input);
    const journalFile = path.join(root, start.id + '.json');
    let oldLocalSnapshot = '';
    try {
      await fx.verificationEntered; // publication has already affected synthetic destination
      const pending = await readJournal(root, start.id);
      assert.equal(pending.state, 'PUBLISHING');
      assert.equal(pending.publication?.dispatched, true);
      assert.equal(pending.publication?.epoch, 3);
      assert.equal(pending.bytesConfirmed, source.length);
      assert.equal(fx.publishes, 1);
      assert.equal(fx.authentic(), true, 'receipt HMAC is correct but not proof of current owner');
      oldLocalSnapshot = await fs.readFile(journalFile, 'utf8');
      // Independent external epoch is moved forward and fsynced while worker
      // and Connection-compatible journal are NOT changed.
      await persist(ownerFile, JSON.stringify({
        ownerEpoch: 42, grantGeneration: 18, deviceEpoch: randomUUID(),
      }));
    } finally {
      fx.release();
      await owner.waitForIdle(start.id);
    }
    const after = await readJournal(root, start.id);
    assert.equal(after.state, 'MUTATION_UNKNOWN');
    assert.equal(after.errorCode, 'CORE_GRANT_EPOCH_STALE');
    assert.equal(after.publication?.dispatched, true);
    assert.equal(after.publication?.sha256, sha256(source));
    assert.equal(after.bytesConfirmed, source.length);
    assert.equal(fx.verifications, 1);
    assert.equal(fx.finalReadbackHashes, 0,
      'no destination readback after the independent authority revoked owner');
    assert.equal(fx.writes, 2);
    assert.equal(fx.publishes, 1);

    // Re-open a DIFFERENT Hub after rolling back ONLY its local journal.
    // The external owner epoch file, key and actual Native side effect stay
    // outside this rollback and must not be accepted as stale authority.
    await persist(journalFile, oldLocalSnapshot);
    const restored = await readJournal(root, start.id);
    assert.equal(restored.state, 'PUBLISHING');
    assert.equal(restored.publication?.requestId, after.publication?.requestId);
    assert.equal(restored.publication?.dispatched, true);
    const secondHub = fx.jobs(root);
    await assert.rejects(secondHub.start({ ...input, resumeTransferId: start.id }),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_GRANT_EPOCH_STALE');
    await assert.rejects(secondHub.status(start.id,
      input.accountId, input.sourceDeviceId, input.targetDeviceId),
      (e: unknown) => e instanceof TransferTrustError && e.code === 'CORE_GRANT_EPOCH_STALE');
    assert.equal(fx.publishes, 1, 'external revoke must not replay local rolled-back publish intent');
    assert.equal(fx.writes, 2);
  }));

test('#21 signed final publication receipt with FOREIGN immutable SHA fails before external attestation and never replays',
  { timeout: 15_000 }, async () => isolated(async (root, ownerFile) => {
    const fx = fixture(ownerFile, 'signed-but-wrong-final-sha');
    const owner = fx.jobs(root);
    const start = await owner.start(input);
    await owner.waitForIdle(start.id);
    const j = await readJournal(root, start.id);
    assert.equal(fx.authentic(), true,
      'this is a correctly HMAC-signed forged SHA claim, not an invalid MAC fixture');
    assert.equal(fx.receipt?.requestId, j.publication?.requestId);
    assert.equal(fx.receipt?.sha256, '0'.repeat(64));
    assert.equal(j.sha256, sha256(source));
    assert.equal(j.publication?.sha256, sha256(source),
      'immutable durable publication intent must retain ORIGINAL full SHA');
    assert.equal(j.publication?.dispatched, true);
    assert.equal(j.state, 'MUTATION_UNKNOWN');
    assert.equal(j.errorCode, 'FINAL_RECEIPT_MISMATCH');
    assert.equal(j.bytesConfirmed, source.length);
    assert.equal(fx.verifications, 0, 'wrong immutable SHA rejected before signer acceptance');
    assert.equal(fx.finalReadbackHashes, 0);
    assert.equal(fx.publishes, 1);
    const afterCancel = await fx.jobs(root).cancel(start.id,
      input.accountId, input.sourceDeviceId, input.targetDeviceId);
    assert.equal(afterCancel.state, 'MUTATION_UNKNOWN');
    assert.equal((await readJournal(root, start.id)).publication?.requestId,
      j.publication?.requestId);
    assert.equal((await readJournal(root, start.id)).errorCode, 'FINAL_RECEIPT_MISMATCH');
    assert.equal(fx.publishes, 1);
  }));

test('#21 second-chunk forged Native write ACK cannot reach authenticated FINAL publication or replay',
  { timeout: 15_000 }, async () => isolated(async (root, ownerFile) => {
    const fx = fixture(ownerFile, 'forged-second-chunk-write-ack');
    const owner = fx.jobs(root);
    const start = await owner.start(input);
    await owner.waitForIdle(start.id);
    const j = await readJournal(root, start.id);
    assert.equal(j.state, 'MUTATION_UNKNOWN');
    assert.equal(j.errorCode, 'FORGED_WRITE_RECEIPT');
    assert.equal(j.bytesConfirmed, CHUNK, 'second chunk ACK cannot be credited');
    assert.equal(j.pending?.offset, CHUNK);
    assert.equal(j.pending?.length, source.length - CHUNK);
    assert.equal(j.pending?.dispatched, true);
    assert.equal(j.pending?.sha256, sha256(source.subarray(CHUNK)));
    assert.ok(j.pending?.requestId);
    assert.equal(j.publication, undefined, 'final publication intent must never be issued');
    assert.equal(fx.writes, 2);
    assert.equal(fx.publishes, 0);
    assert.equal(fx.verifications, 0);
    const otherHub = fx.jobs(root);
    assert.equal((await otherHub.cancel(start.id, input.accountId,
      input.sourceDeviceId, input.targetDeviceId)).state, 'MUTATION_UNKNOWN');
    const final = await readJournal(root, start.id);
    assert.equal(final.pending?.requestId, j.pending?.requestId);
    assert.equal(final.pending?.sha256, j.pending?.sha256);
    assert.equal(final.errorCode, 'FORGED_WRITE_RECEIPT');
    assert.equal(fx.writes, 2, 'no replay of forged second-chunk ACK');
    assert.equal(fx.publishes, 0);
  }));
