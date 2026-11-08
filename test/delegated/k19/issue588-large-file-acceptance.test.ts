import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {executeCapability} from '../../../src/agent/executors.js';
import {PathPolicy} from '../../../src/agent/path-policy.js';
import {
  CROSS_DEVICE_CHUNK_BYTES,
  CrossDeviceTransferError,
  transferCrossDeviceFile,
  type CrossDeviceFileTransferOps,
} from '../../../src/mcp/cross-device-file-transfer.js';

// #588/#539-R15: two isolated local directory policies, not two authenticated
// Agent devices. This uses real bounded file capabilities but NO Hub, network,
// account grants, provider or real Windows machine.
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ID = '4a728d4e-4e49-4e29-a725-f746b61f5612';

async function lab(run: (f: {
  source: string;
  destination: string;
  sourcePolicy: PathPolicy;
  destinationPolicy: PathPolicy;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'nw-k19-issue588-'));
  const sourceDir = path.join(root, 'source');
  const destinationDir = path.join(root, 'destination');
  await mkdir(sourceDir);
  await mkdir(destinationDir);
  try {
    await run({
      source: sourceDir,
      destination: destinationDir,
      sourcePolicy: new PathPolicy([sourceDir]),
      destinationPolicy: new PathPolicy([destinationDir]),
    });
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

function nativeFixture(sourcePath: string, sourcePolicy: PathPolicy,
  destinationPolicy: PathPolicy) {
  let reads = 0;
  let writes = 0;
  let maxChunk = 0;
  let atomicPublishes = 0;
  const capability = async (name: string, input: Record<string, unknown>, policy: PathPolicy) => {
    const result = await executeCapability(name, input, policy) as {
      data: Record<string, unknown>;
    };
    return result.data;
  };
  const hash = async (filename: string, policy: PathPolicy) => {
    const data = await capability('files.hash', {path: filename}, policy);
    return String(data.sha256);
  };
  const ops: CrossDeviceFileTransferOps = {
    statSource: async () => {
      const data = await capability('files.stat', {path: sourcePath}, sourcePolicy);
      return {size: Number(data.size), type: String(data.type)};
    },
    hashSource: () => hash(sourcePath, sourcePolicy),
    readSource: async (offsetBytes, maxBytes) => {
      const data = await capability('files.read', {
        path: sourcePath, encoding: 'base64', offset_bytes: offsetBytes,
        max_bytes: maxBytes,
      }, sourcePolicy);
      reads++;
      maxChunk = Math.max(maxChunk, Number(data.bytesRead));
      return {
        sourceBytes: Number(data.size), offsetBytes: Number(data.offsetBytes),
        bytesRead: Number(data.bytesRead), content: String(data.content),
      };
    },
    writeStage: async (stage, content, offsetBytes, first) => {
      const data = await capability('files.write', {
        path: stage, content, encoding: 'base64',
        mode: first ? 'create' : 'write_at',
        ...(!first ? {offset_bytes: offsetBytes} : {}),
      }, destinationPolicy);
      writes++;
      return Number(data.bytesWritten);
    },
    hashStage: stage => hash(stage, destinationPolicy),
    commitStage: async (stage, destination) => {
      atomicPublishes++;
      await capability('files.move', {
        source: stage, destination, overwrite: false, atomic_no_overwrite: true,
      }, destinationPolicy);
    },
    cleanupStage: async stage => {
      await capability('files.delete', {path: stage, recursive: false}, destinationPolicy);
    },
  };
  return {
    ops,
    get reads() { return reads; },
    get writes() { return writes; },
    get maxChunk() { return maxChunk; },
    get atomicPublishes() { return atomicPublishes; },
  };
}

test('T-363/T-367: 221 KiB and 1 MiB UTF-8 filenames transfer through bounded real local file I/O', async () => {
  await lab(async f => {
    for (const [bytes, name] of [
      [221 * 1024, '221KiB-ışık-🧪.bin'],
      [1024 * 1024, '1MiB-uzun-öçşğü-🔬-rapor.bin'],
    ] as const) {
      const source = path.join(f.source, name);
      const dest = path.join(f.destination, name);
      const data = Buffer.alloc(bytes);
      for (let i = 0; i < data.length; i++) data[i] = (i * 13 + 17) % 251;
      await writeFile(source, data);
      const transfer = nativeFixture(source, f.sourcePolicy, f.destinationPolicy);
      const receipt = await transferCrossDeviceFile(dest, transfer.ops, {
        newId: () => ID, maxBytes: 8 * 1024 * 1024,
      });
      assert.equal(receipt.state, 'COMPLETE');
      assert.equal(receipt.destination, dest);
      assert.equal(receipt.bytesTransferred, bytes);
      assert.equal(receipt.chunkCount, Math.ceil(bytes / CROSS_DEVICE_CHUNK_BYTES));
      assert.equal(transfer.reads, receipt.chunkCount);
      assert.equal(transfer.writes, receipt.chunkCount);
      assert.ok(transfer.maxChunk <= CROSS_DEVICE_CHUNK_BYTES);
      assert.equal(transfer.atomicPublishes, 1);
      assert.equal(sha(await readFile(dest)), receipt.sha256);
      assert.equal(sha(await readFile(source)), receipt.sha256);
      assert.ok(!(await readdir(f.destination)).some(x => x.includes('.nexowire-upload-')));
    }
  });
});

test('T-364: failed second-chunk read does not produce success or a published destination', async () => {
  await lab(async f => {
    const source = path.join(f.source, 'interrupted.bin');
    const dest = path.join(f.destination, 'interrupted.bin');
    await writeFile(source, Buffer.alloc(221 * 1024, 0x5a));
    const fixture = nativeFixture(source, f.sourcePolicy, f.destinationPolicy);
    let reads = 0;
    const ops: CrossDeviceFileTransferOps = {...fixture.ops, readSource: async (offset, size) => {
      if (++reads === 2) throw new Error('simulated stream interrupted');
      return fixture.ops.readSource(offset, size);
    }};
    await assert.rejects(transferCrossDeviceFile(dest, ops, {newId: () => ID}),
      /simulated stream interrupted/);
    assert.equal(reads, 2);
    assert.equal(fixture.atomicPublishes, 0);
    assert.deepEqual(await readdir(f.destination), []);
    // A caller with no independently verified destination must display UNKNOWN,
    // not "completed" or "retry resumes at 48 KiB" (the direct copy has no resume).
  });
});

test('T-365: pre-existing destination and unsafe overwrite request leave user bytes intact', async () => {
  await lab(async f => {
    const source = path.join(f.source, 'source.bin');
    const dest = path.join(f.destination, 'target.bin');
    const existing = Buffer.from('OWNER FILE MUST REMAIN');
    await writeFile(source, Buffer.alloc(221 * 1024, 11));
    await writeFile(dest, existing);
    const fixture = nativeFixture(source, f.sourcePolicy, f.destinationPolicy);
    await assert.rejects(transferCrossDeviceFile(dest, fixture.ops, {newId: () => ID}),
      /EEXIST|Destination already exists/);
    assert.deepEqual(await readFile(dest), existing);
    assert.equal((await readdir(f.destination)).length, 1);

    const stage = path.join(f.destination, 'other-stage.tmp');
    await writeFile(stage, 'new data');
    await assert.rejects(executeCapability('files.move', {
      source: stage, destination: dest, overwrite: true, atomic_no_overwrite: true,
    }, f.destinationPolicy), /overwrite=false/);
    assert.deepEqual(await readFile(dest), existing);
    assert.equal(await readFile(stage, 'utf8'), 'new data');
  });
});

test('T-366: operation receipt alone does not prove immutable post-publish content', async () => {
  await lab(async f => {
    const source = path.join(f.source, 'report.bin');
    const dest = path.join(f.destination, 'report.bin');
    const bytes = Buffer.alloc(221 * 1024, 23);
    await writeFile(source, bytes);
    const fixture = nativeFixture(source, f.sourcePolicy, f.destinationPolicy);
    const receipt = await transferCrossDeviceFile(dest, fixture.ops, {newId: () => ID});
    assert.equal(receipt.state, 'COMPLETE');
    assert.equal(sha(await readFile(dest)), receipt.sha256);
    // A separate writer after commit can change the destination: a later UI
    // must not treat the earlier receipt as fresh independent readback.
    await writeFile(dest, Buffer.alloc(bytes.length, 24));
    assert.notEqual(sha(await readFile(dest)), receipt.sha256);
  });
});

test('T-363: larger total sizes are rejected before I/O by current bounded helper', async () => {
  let hashCalls = 0;
  let readCalls = 0;
  const oversized: CrossDeviceFileTransferOps = {
    statSource: async () => ({size: 256 * 1024 * 1024 + 1, type: 'file'}),
    hashSource: async () => {hashCalls++; return 'a'.repeat(64);},
    readSource: async () => {readCalls++; throw new Error('should not read');},
    writeStage: async () => {throw new Error('should not write');},
    hashStage: async () => 'a'.repeat(64),
    commitStage: async () => {throw new Error('should not publish');},
    cleanupStage: async () => {throw new Error('should not cleanup');},
  };
  await assert.rejects(transferCrossDeviceFile('not-created.bin', oversized),
    (e: unknown) => e instanceof CrossDeviceTransferError &&
      e.code === 'TRANSFER_SOURCE_INVALID');
  assert.equal(hashCalls, 0);
  assert.equal(readCalls, 0);
  // This confirms an outstanding #588 size ceiling, NOT acceptance above 256 MiB.
});
