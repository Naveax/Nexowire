/** #588 / #539 R15: test-only receiver-ack evidence model, NOT production protocol. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

interface ReceiverProof {
  operationId: string;
  deviceId: string;
  destination: string;
  bytes: number;
  sha256: string;
}

interface ReferenceEvidence {
  operationId: string;
  expectedDeviceId: string;
  destination: string;
  bytesTotal: number;
  bytesSent: number;
  sourceSha256: string;
  receiverAck?: ReceiverProof;
  independentReceiverReadback?: ReceiverProof;
  destinationConflictVerified?: boolean;
}

type ReferenceState = 'SENDING' | 'UNVERIFIED' | 'VERIFIED' | 'CONFLICT';

/** Deliberately strict UX gate: neither sender hash nor naked ACK is enough. */
function view(e: ReferenceEvidence): { state: ReferenceState; message: string } {
  if (e.destinationConflictVerified === true) {
    return { state: 'CONFLICT', message: 'Hedefte zaten dosya var; üzerine yazılmadı.' };
  }
  if (e.bytesSent < e.bytesTotal && e.bytesSent >= 0) {
    return { state: 'SENDING', message: 'Aktarım sürüyor; teslim henüz doğrulanmadı.' };
  }
  const same = (p: ReceiverProof | undefined) => p !== undefined &&
    p.operationId === e.operationId && p.deviceId === e.expectedDeviceId &&
    p.destination === e.destination && p.bytes === e.bytesTotal &&
    p.sha256 === e.sourceSha256;
  if (e.bytesSent === e.bytesTotal && same(e.receiverAck) &&
      same(e.independentReceiverReadback)) {
    return { state: 'VERIFIED', message: 'Alıcı dosyası bağımsız olarak doğrulandı.' };
  }
  return { state: 'UNVERIFIED', message: 'Baytlar gönderilmiş olabilir; alıcı teslimi doğrulanmadı.' };
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const op = 'k19-test-op-0001';
const device = 'destination-device-fixture';

async function lab(run: (files: { src: string; staged: string; final: string }) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'nw-p006-k19-'));
  const files = {
    src: path.join(root, 'source-ışık-🧪.bin'),
    staged: path.join(root, 'staged-ışık-🧪.bin'),
    final: path.join(root, 'receiver-ışık-🧪.bin'),
  };
  try { await run(files); } finally { await rm(root, { recursive: true, force: true }); }
}

const bytesFor = (size: number) => Buffer.from(Array.from({ length: size }, (_, i) =>
  (i * 17 + 11) % 251));

const evidence = (buffer: Buffer, destination: string): ReferenceEvidence => ({
  operationId: op,
  expectedDeviceId: device,
  destination,
  bytesTotal: buffer.byteLength,
  bytesSent: buffer.byteLength,
  sourceSha256: digest(buffer),
});

const receipt = (e: ReferenceEvidence): ReceiverProof => ({
  operationId: e.operationId,
  deviceId: e.expectedDeviceId,
  destination: e.destination,
  bytes: e.bytesTotal,
  sha256: e.sourceSha256,
});

test('T-643: sender 221 KiB stage write and matching sender SHA are not receiver apply', async () => {
  await lab(async f => {
    const data = bytesFor(221 * 1024);
    await writeFile(f.src, data);
    await writeFile(f.staged, await readFile(f.src));
    assert.equal(digest(await readFile(f.staged)), digest(data));
    await assert.rejects(stat(f.final), { code: 'ENOENT' });
    const result = view(evidence(data, f.final));
    assert.equal(result.state, 'UNVERIFIED');
    assert.match(result.message, /doğrulanmadı/);
  });
});

test('T-644: even 1 MiB+ staged receiver hash cannot replace an ACK', async () => {
  await lab(async f => {
    const data = bytesFor(1024 * 1024 + 19);
    await writeFile(f.staged, data);
    const e = evidence(data, f.final);
    assert.equal(digest(await readFile(f.staged)), e.sourceSha256);
    assert.equal(view(e).state, 'UNVERIFIED');
    assert.equal(view({ ...e, independentReceiverReadback: receipt(e) }).state, 'UNVERIFIED');
  });
});

test('T-643/T-645: final file may exist after lost ACK, but sender remains UNKNOWN', async () => {
  await lab(async f => {
    const data = bytesFor(221 * 1024);
    await writeFile(f.final, data);
    const e = evidence(data, f.final);
    assert.equal(digest(await readFile(f.final)), e.sourceSha256);
    assert.equal(view(e).state, 'UNVERIFIED');
    assert.equal(view({ ...e, independentReceiverReadback: receipt(e) }).state, 'UNVERIFIED');
  });
});

test('T-646/T-647: 100% bytes sent plus ACK without independent readback is UNVERIFIED', () => {
  const data = bytesFor(221 * 1024);
  const e = evidence(data, '/unverified/destination');
  assert.equal(e.bytesSent / e.bytesTotal, 1);
  assert.equal(view({ ...e, receiverAck: receipt(e) }).state, 'UNVERIFIED');
  assert.doesNotMatch(view({ ...e, receiverAck: receipt(e) }).message, /tamamlandı/i);
});

test('T-643/T-647: receiver ACK bound to wrong device or operation cannot certify completion', () => {
  const e = evidence(bytesFor(221 * 1024), '/receiver/destination');
  const good = receipt(e);
  assert.equal(view({ ...e, receiverAck: { ...good, deviceId: 'other-device' },
    independentReceiverReadback: good }).state, 'UNVERIFIED');
  assert.equal(view({ ...e, receiverAck: { ...good, operationId: 'other-operation' },
    independentReceiverReadback: good }).state, 'UNVERIFIED');
  assert.equal(view({ ...e, receiverAck: good,
    independentReceiverReadback: { ...good, destination: '/other/path' } }).state, 'UNVERIFIED');
});

test('T-646: test-only positive receiver apply requires both ACK and fresh final digest', async () => {
  await lab(async f => {
    const data = bytesFor(1024 * 1024 + 19);
    await writeFile(f.staged, data);
    await copyFile(f.staged, f.final, constants.COPYFILE_EXCL);
    const e = evidence(data, f.final);
    const final = await readFile(f.final);
    const independent = { ...receipt(e), bytes: final.length, sha256: digest(final) };
    assert.equal(view({ ...e, receiverAck: receipt(e),
      independentReceiverReadback: independent }).state, 'VERIFIED');
    // A post-receipt writer invalidates fresh independent readback.
    await writeFile(f.final, Buffer.from('changed after receipt'));
    const changed = await readFile(f.final);
    assert.equal(view({ ...e, receiverAck: receipt(e), independentReceiverReadback: {
      ...independent, bytes: changed.length, sha256: digest(changed),
    } }).state, 'UNVERIFIED');
  });
});

test('T-645: same-name collision preserves original content and reports conflict only when verified', async () => {
  await lab(async f => {
    const existing = Buffer.from('original target bytes');
    await writeFile(f.final, existing);
    await writeFile(f.staged, bytesFor(221 * 1024));
    await assert.rejects(copyFile(f.staged, f.final, constants.COPYFILE_EXCL),
      { code: 'EEXIST' });
    assert.deepEqual(await readFile(f.final), existing);
    const e = evidence(await readFile(f.staged), f.final);
    assert.equal(view(e).state, 'UNVERIFIED', 'EEXIST signal alone is not a trusted conflict UI state');
    assert.equal(view({ ...e, destinationConflictVerified: true }).state, 'CONFLICT');
  });
});

test('T-647: transfer below 100% stays in progress and over-count is not treated as success', () => {
  const e = evidence(bytesFor(221 * 1024), '/receiver/destination');
  assert.equal(view({ ...e, bytesSent: e.bytesTotal - 1 }).state, 'SENDING');
  assert.equal(view({ ...e, bytesSent: e.bytesTotal + 1,
    receiverAck: receipt(e), independentReceiverReadback: receipt(e) }).state, 'UNVERIFIED');
});
