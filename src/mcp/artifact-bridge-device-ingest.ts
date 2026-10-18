import { ArtifactBridgeError, type ArtifactBridgeStore, type ArtifactManifest, type ArtifactScope } from '../workspace/artifact-bridge.js';

// Server-side bounded pull. Agent bytes flow only through the authenticated Hub
// execution context and are never included in MCP tool results.
export interface ArtifactSourceOps {
  stat(path: string): Promise<{ type: string; size: number }>;
  sha256(path: string, maxBytes: number): Promise<string>;
  read(path: string, offset: number, maxBytes: number): Promise<{
    sourceBytes: number; offsetBytes: number; bytesRead: number; contentBase64: string;
  }>;
}
export interface DeviceIngestInput {
  scope: ArtifactScope;
  sourcePath: string;
  artifactPath: string;
  repository: string;
  commitSha: string;
  producerOperationId: string;
  testStatus: ArtifactManifest['testStatus'];
  acceptanceStatus: ArtifactManifest['acceptanceStatus'];
  expectedPreviousSha256?: string;
  maxChunks?: number;
}
const hex = /^[0-9a-f]{64}$/;
const fail = (code: string, message: string): never => {
  throw new ArtifactBridgeError(code, message);
};
export async function ingestDeviceArtifact(
  store: ArtifactBridgeStore,
  source: ArtifactSourceOps,
  input: DeviceIngestInput,
): Promise<{ state: 'ALREADY_PRESENT' | 'PARTIAL' | 'COMPLETE'; sha256: string;
  transferredBytes: number; size: number; offset: number; artifactPath: string }> {
  const maxChunks = input.maxChunks ?? 16;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 32) {
    return fail('INGEST_CHUNK_LIMIT', 'Per-call ingest limit must be 1 to 32 chunks.');
  }
  if (typeof input.sourcePath !== 'string' || input.sourcePath.length < 1 ||
      input.sourcePath.length > 4096) {
    return fail('INGEST_SOURCE_INVALID', 'Source path is invalid.');
  }
  const stat = await source.stat(input.sourcePath);
  if (stat.type !== 'file' || !Number.isSafeInteger(stat.size) || stat.size < 0 ||
      stat.size > 268_435_456) {
    return fail('INGEST_SOURCE_INVALID', 'Source must be a regular file within 256 MiB.');
  }
  const expected = (await source.sha256(input.sourcePath, 268_435_456)).toLowerCase();
  if (!hex.test(expected)) return fail('INGEST_HASH_INVALID', 'Source SHA-256 is invalid.');
  const begin = await store.begin({
    scope: input.scope,
    artifactPath: input.artifactPath,
    repository: input.repository,
    commitSha: input.commitSha,
    producerOperationId: input.producerOperationId,
    size: stat.size, sha256: expected,
    testStatus: input.testStatus,
    acceptanceStatus: input.acceptanceStatus,
    ...(input.expectedPreviousSha256 ? {
      expectedPreviousSha256: input.expectedPreviousSha256,
    } : {}),
  });
  if (begin.state === 'ALREADY_PRESENT') {
    return { state: 'ALREADY_PRESENT', sha256: expected, size: stat.size,
      offset: stat.size, transferredBytes: 0, artifactPath: input.artifactPath };
  }
  const sessionId = begin.sessionId;
  if (!sessionId) return fail('INGEST_SESSION_MISSING', 'No durable ingest session was created.');
  let offset = begin.offset;
  let transferredBytes = 0;
  for (let n = 0; n < maxChunks && offset < stat.size; n++) {
    const size = Math.min(65536, stat.size - offset);
    const chunk = await source.read(input.sourcePath, offset, size);
    if (chunk.sourceBytes !== stat.size || chunk.offsetBytes !== offset ||
        chunk.bytesRead !== size || typeof chunk.contentBase64 !== 'string') {
      return fail('INGEST_SOURCE_CHANGED', 'Source file changed while reading an ingest chunk.');
    }
    // putChunk verifies canonical Base64 and the precise committed offset.
    const result = await store.putChunk(input.scope, sessionId, offset, chunk.contentBase64);
    if (result.state !== 'WRITTEN' || result.offset !== offset + size) {
      return fail('INGEST_OFFSET_MISMATCH', 'The destination did not accept the expected chunk.');
    }
    transferredBytes += size;
    offset += size;
  }
  // If the first batch is partial, the caller can resume by invoking the same
  // tool with unchanged parameters. We check source digest on each invocation.
  if (offset < stat.size) {
    return { state: 'PARTIAL', offset, size: stat.size, sha256: expected,
      transferredBytes, artifactPath: input.artifactPath };
  }
  const finalHash = (await source.sha256(input.sourcePath, 268_435_456)).toLowerCase();
  if (finalHash !== expected) {
    return fail('INGEST_SOURCE_CHANGED', 'Source SHA-256 changed before final publication.');
  }
  const manifest = await store.commit(input.scope, sessionId);
  return { state: 'COMPLETE', sha256: manifest.sha256, size: stat.size,
    transferredBytes, offset: stat.size, artifactPath: input.artifactPath };
}
