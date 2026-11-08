import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  LIMIT_SOURCE_PATHS,
  parseIssue588SourceLimits,
  readIssue588SourceLimits,
  type LimitSources,
} from './issue588-limits-inventory.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = async (): Promise<LimitSources> => Object.fromEntries(await Promise.all(
  (Object.entries(LIMIT_SOURCE_PATHS) as Array<[keyof LimitSources, string]>).map(async ([key, path]) =>
    [key, await readFile(join(root, path), 'utf8')]),
)) as LimitSources;

test('source-derived #588 limit inventory is stable for current main implementation', async () => {
  const inventory = await readIssue588SourceLimits(root);
  assert.deepEqual(inventory, {
    schemaVersion: 1,
    directMcpMaxBytes: 8_388_608,
    directHelperMaxBytes: 67_108_864,
    directChunkBytes: 49_152,
    artifactIngestMaxBytes: 268_435_456,
    artifactIngestChunkBytes: 65_536,
    artifactIngestMaxChunksPerCall: 32,
    artifactManifestMaxBytes: 268_435_456,
    artifactManifestChunkMaxBytes: 65_536,
    artifactManifestMaxChunks: 4096,
  });
  assert.ok(inventory.directMcpMaxBytes < inventory.directHelperMaxBytes,
    'public MCP tool limit must not be confused with the helper limit');
});

test('unrelated max_bytes elsewhere cannot substitute for missing file-transfer schema', async () => {
  const sources = await load();
  const changed = sources.mcpRegistration.replace(
    /max_bytes:\s*z\.number\(\)\.int\(\)\.min\(1\)\.max\(8_388_608\)\.optional\(\)/,
    'max_bytes: customFileTransferLimit.optional()',
  );
  assert.notEqual(changed, sources.mcpRegistration);
  assert.throws(() => parseIssue588SourceLimits({ ...sources, mcpRegistration: changed }),
    /MCP file_transfer max_bytes: expected exactly one/);
});

test('missing helper constant fails closed instead of emitting stale hardcoded limits', async () => {
  const sources = await load();
  const changed = sources.directTransfer.replace('CROSS_DEVICE_MAX_BYTES=64*1024*1024;',
    'CROSS_DEVICE_MAX_BYTES=dynamicLimit;');
  assert.notEqual(changed, sources.directTransfer);
  assert.throws(() => parseIssue588SourceLimits({ ...sources, directTransfer: changed }),
    /cross-device helper maximum: expected exactly one/);
});

test('duplicate declarations and non-arithmetic expressions are never silently accepted', async () => {
  const sources = await load();
  assert.throws(() => parseIssue588SourceLimits({ ...sources,
    directTransfer: `${sources.directTransfer}\nexport const CROSS_DEVICE_CHUNK_BYTES=1;`,
  }), /cross-device default chunk: expected exactly one/);
  const changed = sources.directTransfer.replace('CROSS_DEVICE_CHUNK_BYTES=48*1024;',
    'CROSS_DEVICE_CHUNK_BYTES=2**20;');
  assert.throws(() => parseIssue588SourceLimits({ ...sources, directTransfer: changed }),
    /cross-device default chunk: expected exactly one/);
});

test('changing an implemented source bound updates inventory rather than being reported PASS', async () => {
  const sources = await load();
  const modified = sources.deviceIngest.replace('maxChunks > 32)', 'maxChunks > 24)');
  assert.notEqual(modified, sources.deviceIngest);
  assert.equal(parseIssue588SourceLimits({ ...sources, deviceIngest: modified })
    .artifactIngestMaxChunksPerCall, 24);
});
