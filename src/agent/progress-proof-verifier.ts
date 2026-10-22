/**
 * Independent *file consistency* verifier for managed worker output.
 *
 * An Agent-selected, trusted scope/root is required. Worker-owned stdout,
 * claimed totals, a PID and a worker-computed digest are never authoritative.
 * This can prove committed JSON result files exist and match a reported
 * manifest, NOT that the application performed semantically correct work.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';

const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/);
const SHA = z.string().regex(/^[a-f0-9]{64}$/);
const COUNT = z.number().int().nonnegative().max(1000);
const Scope = z.object({
  ownerAccountId: ID, deviceId: ID, projectId: ID, runId: ID, sessionId: ID,
}).strict();
const Entry = z.object({
  itemId: ID,
  filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.json$/),
  sha256: SHA,
}).strict();
const Manifest = z.object({
  schemaVersion: z.literal(1),
  scope: Scope,
  expectedCount: COUNT,
  sealed: z.boolean(),
  artifacts: z.array(Entry).max(1000),
}).strict();
const ResultFile = z.object({
  schemaVersion: z.literal(1),
  runId: ID,
  itemId: ID,
  outcome: z.enum(['completed', 'failed']),
  payload: z.unknown().optional(),
}).strict();

export type ProgressProofScope = z.infer<typeof Scope>;
export interface ProgressProofRequest {
  /** Chosen by trusted caller; NEVER derived from worker stdout. */
  runRoot: string;
  scope: ProgressProofScope;
  /** Trusted task specification, not a manifest/worker-controlled value. */
  expectedCount: number;
}
export interface ProgressProofReport {
  status: 'verified' | 'unverified';
  reason: string;
  completedCount: number | null;
  pendingCount: number | null;
  failureCount: number | null;
  artifactSha256: string | null;
  sealed: boolean;
  verifiedAt: string | null;
  /** Untrusted filesystem mtime hint: NOT an independent completion clock. */
  lastArtifactModifiedAt: string | null;
}

export function digestResultSet(entries: readonly {
  itemId: string; outcome: 'completed' | 'failed'; sha256: string;
}[]): string {
  const hash = createHash('sha256');
  hash.update('NEXOWIRE_RESULT_SET_V1\n');
  // Codepoint ordering is deterministic across OS locales and ICU builds.
  for (const entry of [...entries].sort((a, b) => a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0)) {
    hash.update(JSON.stringify([entry.itemId, entry.outcome, entry.sha256]) + '\n');
  }
  return hash.digest('hex');
}

class ProofError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function refuse(code: string): never { throw new ProofError(code); }

const MAX_RESULT_BYTES = 128 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/**
 * Never follow symlinks/junctions. Verify the file descriptor and recheck
 * identity after reading. A live worker can still change its own files
 * later; a protected, immutable artifact handoff is a production blocker.
 */
async function readPinnedFile(file: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size > maxBytes || before.size < 1) refuse('FILE_UNTRUSTED');
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(file, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      refuse('FILE_CHANGED');
    }
    // A worker may append to its writable file during verification. Do not
    // let FileHandle.readFile() allocate unbounded memory for that race.
    // Read at most the originally attested byte length, then fail closed if
    // the file changed or grew.
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(
        data, offset, data.length - offset, offset,
      );
      if (bytesRead === 0) refuse('FILE_CHANGED');
      offset += bytesRead;
    }
    const closed = await handle.stat();
    const after = await lstat(file);
    if (data.length !== before.size || data.length > maxBytes ||
        after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        closed.size !== before.size || closed.mtimeMs !== before.mtimeMs) {
      refuse('FILE_CHANGED');
    }
    return data;
  } finally { await handle.close(); }
}
async function ordinaryDirectory(dir: string): Promise<void> {
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('DIRECTORY_UNTRUSTED');
  const resolved = await realpath(dir);
  if (path.resolve(resolved).toLowerCase() !== path.resolve(dir).toLowerCase()) {
    refuse('DIRECTORY_UNTRUSTED');
  }
}
const rejected: ProgressProofReport = {
  status: 'unverified', reason: 'PROOF_UNAVAILABLE', completedCount: null,
  pendingCount: null, failureCount: null, artifactSha256: null,
  sealed: false, verifiedAt: null, lastArtifactModifiedAt: null,
};

/** Rehash and parse actual bounded result files; no code execution. */
export async function verifyResultFiles(
  request: ProgressProofRequest,
  now: () => number = Date.now,
): Promise<ProgressProofReport> {
  try {
    if (!Scope.safeParse(request.scope).success ||
        !Number.isSafeInteger(request.expectedCount) ||
        request.expectedCount < 0 || request.expectedCount > 1000 ||
        typeof request.runRoot !== 'string' || !path.isAbsolute(request.runRoot)) {
      refuse('TRUSTED_SCOPE_REQUIRED');
    }
    await ordinaryDirectory(request.runRoot);
    const resultsDir = path.join(request.runRoot, 'results');
    await ordinaryDirectory(resultsDir);
    const manifestBytes = await readPinnedFile(path.join(request.runRoot, 'manifest.json'),
      MAX_MANIFEST_BYTES);
    const manifest = Manifest.safeParse(JSON.parse(manifestBytes.toString('utf8')));
    if (!manifest.success) refuse('MANIFEST_INVALID');
    const spec = manifest.data;
    if (Object.entries(request.scope).some(([field, value]) =>
      spec.scope[field as keyof ProgressProofScope] !== value) ||
      spec.expectedCount !== request.expectedCount) refuse('SCOPE_MISMATCH');
    if (spec.artifacts.length > spec.expectedCount) refuse('COUNT_MISMATCH');

    let totalBytes = manifestBytes.length;
    let completedCount = 0;
    let failureCount = 0;
    let latestMtimeMs: number | null = null;
    const ids = new Set<string>();
    const names = new Set<string>();
    const observed: Array<{itemId: string; outcome: 'completed'|'failed'; sha256: string}> = [];
    for (const item of spec.artifacts) {
      if (ids.has(item.itemId) || names.has(item.filename.toLowerCase())) {
        refuse('DUPLICATE_RESULT');
      }
      ids.add(item.itemId);
      names.add(item.filename.toLowerCase());
      const resultPath = path.join(resultsDir, item.filename);
      const resultBytes = await readPinnedFile(resultPath, MAX_RESULT_BYTES);
      // Metadata is from the filesystem, not from a worker-supplied timestamp.
      const resultStat = await lstat(resultPath);
      if (resultStat.isSymbolicLink()) refuse('FILE_UNTRUSTED');
      latestMtimeMs = Math.max(latestMtimeMs ?? 0, resultStat.mtimeMs);
      totalBytes += resultBytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) refuse('RESULT_SET_TOO_LARGE');
      const sha256 = createHash('sha256').update(resultBytes).digest('hex');
      if (sha256 !== item.sha256) refuse('RESULT_HASH_MISMATCH');
      const parsed = ResultFile.safeParse(JSON.parse(resultBytes.toString('utf8')));
      if (!parsed.success || parsed.data.runId !== request.scope.runId ||
          parsed.data.itemId !== item.itemId) refuse('RESULT_IDENTITY_MISMATCH');
      if (parsed.data.outcome === 'completed') completedCount++;
      else failureCount++;
      observed.push({ itemId: item.itemId, outcome: parsed.data.outcome, sha256 });
    }
    const pendingCount = spec.expectedCount - completedCount - failureCount;
    if (spec.sealed && pendingCount !== 0) refuse('SEALED_INCOMPLETE');
    // Detect manifest mutation during the whole scan, not just one file read.
    const finalManifest = await readPinnedFile(path.join(request.runRoot, 'manifest.json'),
      MAX_MANIFEST_BYTES);
    if (!manifestBytes.equals(finalManifest)) refuse('MANIFEST_CHANGED');
    return {
      status: 'verified', reason: 'RESULT_FILES_REHASHED',
      completedCount, pendingCount, failureCount,
      artifactSha256: digestResultSet(observed), sealed: spec.sealed,
      verifiedAt: new Date(now()).toISOString(),
      lastArtifactModifiedAt: latestMtimeMs === null ? null : new Date(latestMtimeMs).toISOString(),
    };
  } catch (cause) {
    const reason = cause instanceof ProofError ? cause.code : 'PROOF_UNAVAILABLE';
    return { ...rejected, reason };
  }
}
