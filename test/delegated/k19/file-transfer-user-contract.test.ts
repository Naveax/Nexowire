import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  CROSS_DEVICE_CHUNK_BYTES,
  transferCrossDeviceFile,
  type CrossDeviceFileTransferOps,
} from '../../../src/mcp/cross-device-file-transfer.js';

// An offline UX contract fixture. It does not connect to Agent, Hub, MCP,
// an authorization source, a filesystem or a second physical computer.
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function fixture(source: Buffer, options: {
  existingDestination?: Buffer;
  failReadNumber?: number;
  losePublishAcknowledgement?: boolean;
  beforePublish?: () => Promise<void>;
} = {}) {
  let staging: Buffer | null = null;
  let destination = options.existingDestination
    ? Buffer.from(options.existingDestination) : null;
  let readCount = 0;
  let cleanupCount = 0;
  let publishCount = 0;
  const ops: CrossDeviceFileTransferOps = {
    statSource: async () => ({type: 'file', size: source.length}),
    hashSource: async () => digest(source),
    readSource: async (offsetBytes, maxBytes) => {
      readCount++;
      if (readCount === options.failReadNumber) {
        throw new Error('synthetic connection interrupted before final publish');
      }
      const bytes = source.subarray(offsetBytes, offsetBytes + maxBytes);
      return {
        sourceBytes: source.length,
        offsetBytes,
        bytesRead: bytes.length,
        content: bytes.toString('base64'),
      };
    },
    writeStage: async (_stage, content, offset, first) => {
      if (first) staging = Buffer.alloc(0);
      if (staging === null || offset !== staging.length) {
        throw new Error('synthetic stage offset mismatch');
      }
      const bytes = Buffer.from(content, 'base64');
      staging = Buffer.concat([staging, bytes]);
      return bytes.length;
    },
    hashStage: async () => digest(staging ?? Buffer.alloc(0)),
    commitStage: async () => {
      await options.beforePublish?.();
      if (destination !== null) {
        throw new Error('EEXIST: destination already exists');
      }
      assert.notEqual(staging, null);
      destination = Buffer.from(staging!);
      staging = null;
      publishCount++;
      if (options.losePublishAcknowledgement) {
        throw new Error('synthetic publish acknowledgement lost');
      }
    },
    cleanupStage: async () => {
      cleanupCount++;
      staging = null;
    },
  };
  return {
    ops,
    get destination() { return destination; },
    get staging() { return staging; },
    get readCount() { return readCount; },
    get cleanupCount() { return cleanupCount; },
    get publishCount() { return publishCount; },
  };
}

test('T-109/T-110: bounded large transfer stays pending until verified publish completes', async () => {
  const source = Buffer.alloc(8 * 1024 * 1024, 37);
  let enteredPublish!: () => void;
  let releasePublish!: () => void;
  const entered = new Promise<void>(resolve => { enteredPublish = resolve; });
  const gate = new Promise<void>(resolve => { releasePublish = resolve; });
  const f = fixture(source, {beforePublish: async () => {
    enteredPublish();
    await gate;
  }});
  const run = transferCrossDeviceFile('reports/large.bin', f.ops,
    {maxBytes: 8 * 1024 * 1024});
  let settled = false;
  void run.then(() => { settled = true; }, () => { settled = true; });
  await entered;
  assert.equal(settled, false, 'transferred chunks are not proof of final publication');
  assert.equal(f.destination, null, 'no published destination before commit');
  releasePublish();
  const receipt = await run;
  assert.equal(receipt.state, 'COMPLETE');
  assert.equal(receipt.bytesTransferred, source.length);
  assert.equal(receipt.sha256, digest(source));
  assert.equal(receipt.chunkCount, Math.ceil(source.length / CROSS_DEVICE_CHUNK_BYTES));
  assert.equal(f.publishCount, 1);
  assert.deepEqual(f.destination, source);
  assert.equal('percent' in receipt, false, 'MCP receipt has no streaming progress field');
});

test('T-111: interrupted multi-chunk copy has no success receipt or published destination', async () => {
  const f = fixture(Buffer.alloc(220 * 1024, 7), {failReadNumber: 2});
  await assert.rejects(
    transferCrossDeviceFile('reports/interrupted.bin', f.ops),
    /synthetic connection interrupted/,
  );
  assert.equal(f.readCount, 2);
  assert.equal(f.publishCount, 0);
  assert.equal(f.destination, null);
  assert.equal(f.cleanupCount, 1);
  assert.equal(f.staging, null);
  // The caller cannot safely render success. A real UI must use UNKNOWN
  // until an independently verified destination readback is available.
});

test('T-112: same-name destination collision never replaces an existing file', async () => {
  const original = Buffer.from('pre-existing user data');
  const f = fixture(Buffer.alloc(150 * 1024, 4), {existingDestination: original});
  await assert.rejects(
    transferCrossDeviceFile('reports/same-name.bin', f.ops),
    /EEXIST/,
  );
  assert.deepEqual(f.destination, original);
  assert.equal(f.publishCount, 0);
  assert.equal(f.cleanupCount, 1);
});

test('T-113: lost publish acknowledgement makes retry ambiguous, never overwrites destination', async () => {
  const source = Buffer.alloc(80 * 1024, 3);
  const f = fixture(source, {losePublishAcknowledgement: true});
  await assert.rejects(
    transferCrossDeviceFile('reports/ambiguous.bin', f.ops),
    /acknowledgement lost/,
  );
  assert.deepEqual(f.destination, source, 'publication may succeed despite a failed call');
  assert.equal(f.cleanupCount, 1);
  await assert.rejects(
    transferCrossDeviceFile('reports/ambiguous.bin', f.ops),
    /EEXIST/,
  );
  assert.deepEqual(f.destination, source, 'retry must not overwrite a possibly published file');
  assert.equal(f.publishCount, 1);
});

test('T-114: successful offline fixture is not physical two-device acceptance', async () => {
  const f = fixture(Buffer.from('synthetic fixture only'));
  const result = await transferCrossDeviceFile('reports/offline.bin', f.ops);
  assert.equal(result.state, 'COMPLETE');
  assert.equal(f.publishCount, 1);
  assert.equal(result.bytesTransferred, Buffer.byteLength('synthetic fixture only'));
  // No assertion here represents authenticated devices, Windows hard-link
  // behavior, network reconnection, or a real two-PC transfer.
});
