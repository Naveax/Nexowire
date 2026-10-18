import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(256);
const safeName = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/);
const scopeSchema = z.object({
  accountId: identity, projectId: safeName, deviceId: identity,
}).strict();
const logicalPathSchema = z.string().min(1).max(1024).superRefine((value, ctx) => {
  if (value.includes('\\') || value.includes(':') || value.includes('\0') ||
      value.startsWith('/') || value.split('/').some(x => !x || x === '.' || x === '..') ||
      value.endsWith('/') || /[\u0000-\u001f]/.test(value)) {
    ctx.addIssue({ code: 'custom', message: 'Artifact path must be a relative slash-separated project path.' });
  }
});
const testStatus = z.enum(['unverified', 'passed', 'failed']);
const acceptanceStatus = z.enum(['pending', 'accepted', 'rejected']);
const manifestSchema = z.object({
  version: z.literal(1), scope: scopeSchema, artifactPath: logicalPathSchema,
  repository: z.string().min(1).max(512), commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  producerOperationId: safeName, size: z.number().int().min(0).max(268_435_456),
  sha256: shaSchema, createdAt: z.string().datetime(),
  testStatus, acceptanceStatus,
}).strict();
const chunkSchema = z.object({
  offset: z.number().int().min(0), size: z.number().int().min(1).max(65536),
  sha256: shaSchema,
}).strict();
const sessionSchema = z.object({
  id: shaSchema, metadata: manifestSchema,
  expectedPreviousSha256: shaSchema.optional(),
  offset: z.number().int().min(0),
  chunks: z.array(chunkSchema).max(4096),
}).strict();
const projectSchema = z.object({
  version: z.literal(1), scope: scopeSchema, repository: z.string().min(1).max(512),
}).strict();
const checkpointSchema = z.object({
  version: z.literal(1), scope: scopeSchema, workspaceId: identity,
  repository: z.string().min(1).max(512), commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  summary: z.string().max(20000), completed: z.array(z.string().max(4096)).max(200),
  remaining: z.array(z.string().max(4096)).max(200),
  lastCommands: z.array(z.string().max(8192)).max(100),
  artifacts: z.array(manifestSchema).max(128), updatedAt: z.string().datetime(),
}).strict();

export type ArtifactScope = z.infer<typeof scopeSchema>;
export type ArtifactManifest = z.infer<typeof manifestSchema>;
export type ArtifactCheckpoint = z.infer<typeof checkpointSchema>;
type Session = z.infer<typeof sessionSchema>;
export class ArtifactBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message); this.name = 'ArtifactBridgeError';
  }
}
const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const key = (...parts: string[]) => digest(parts.join('\0'));
const fail = (code: string, message: string): never => { throw new ArtifactBridgeError(code, message); };
async function existing<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  try { return schema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return fail('CORRUPT_METADATA', 'Persisted artifact metadata is invalid or unreadable.');
  }
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
async function digestFile(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}
async function regularFile(file: string): Promise<number> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_STORAGE_OBJECT', 'Storage object is not a regular file.');
  return stat.size;
}
function equalScope(a: ArtifactScope, b: ArtifactScope): boolean {
  return a.accountId === b.accountId && a.projectId === b.projectId && a.deviceId === b.deviceId;
}
function canonicalBase64(base64: string): Buffer {
  if (base64.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    return fail('INVALID_CHUNK', 'Chunk must use canonical Base64 (up to 64 KiB).');
  }
  const data = Buffer.from(base64, 'base64');
  if (data.length === 0 || data.length > 65536 || data.toString('base64') !== base64) {
    return fail('INVALID_CHUNK', 'Chunk must use canonical Base64 (up to 64 KiB).');
  }
  return data;
}

export class ArtifactBridgeStore {
  constructor(private readonly root: string) {}
  private dir(scope: ArtifactScope): string {
    const s = scopeSchema.parse(scope);
    return path.join(this.root, 'artifact-bridge-v1', key('account', s.accountId),
      key('project', s.projectId), key('device', s.deviceId));
  }
  private manifestFile(dir: string, artifactPath: string): string {
    return path.join(dir, 'manifests', key(logicalPathSchema.parse(artifactPath)) + '.json');
  }
  private sessionFile(dir: string, id: string): string {
    return path.join(dir, 'sessions', shaSchema.parse(id) + '.json');
  }
  private partFile(dir: string, id: string): string {
    return path.join(dir, 'sessions', shaSchema.parse(id) + '.part');
  }
  private objectFile(dir: string, sha: string): string {
    return path.join(dir, 'objects', shaSchema.parse(sha));
  }
  // Cross-process lock is deliberately fail-closed, never silently stolen after a crash.
  private async locked<T>(dir: string, body: () => Promise<T>): Promise<T> {
    await fs.mkdir(dir, { recursive: true });
    const lock = path.join(dir, '.mutation.lock');
    let handle: fs.FileHandle;
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('BRIDGE_BUSY', 'A writer already holds the artifact scope lock.');
      throw error;
    }
    try { return await body(); }
    finally { await handle.close(); await fs.rm(lock, { force: true }); }
  }
  private async projectGuard(scope: ArtifactScope, repository: string, bind: boolean): Promise<void> {
    const file = path.join(this.dir(scope), 'project.json');
    const pinned = await existing(file, projectSchema);
    if (pinned) {
      if (!equalScope(pinned.scope, scope) || pinned.repository !== repository) {
        fail('PROJECT_REPOSITORY_MISMATCH', 'Project is already bound to a different repository.');
      }
    } else if (bind) {
      await atomicJson(file, projectSchema.parse({ version: 1, scope, repository }));
    } else {
      fail('PROJECT_BINDING_MISSING', 'Artifact exists without a pinned project repository.');
    }
  }
  private async checkManifest(scope: ArtifactScope, artifactPath: string): Promise<ArtifactManifest | null> {
    const dir = this.dir(scope);
    const manifest = await existing(this.manifestFile(dir, artifactPath), manifestSchema);
    if (!manifest) return null;
    if (!equalScope(manifest.scope, scope) || manifest.artifactPath !== artifactPath) {
      return fail('SCOPE_MISMATCH', 'Persisted artifact does not belong to the requested scope/path.');
    }
    await this.projectGuard(scope, manifest.repository, false);
    const file = this.objectFile(dir, manifest.sha256);
    try {
      if (await regularFile(file) !== manifest.size || await digestFile(file) !== manifest.sha256) {
        return fail('CORRUPT_ARTIFACT', 'Stored artifact size or SHA-256 verification failed.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail('ARTIFACT_MISSING', 'Manifest exists but content is missing.');
      throw error;
    }
    return manifest;
  }
  async get(scope: ArtifactScope, artifactPath: string): Promise<ArtifactManifest | null> {
    scopeSchema.parse(scope); logicalPathSchema.parse(artifactPath);
    return this.checkManifest(scope, artifactPath);
  }
  async list(scope: ArtifactScope): Promise<ArtifactManifest[]> {
    const dir = this.dir(scope);
    let names: string[];
    try { names = await fs.readdir(path.join(dir, 'manifests')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (names.length > 10000) fail('LIST_LIMIT', 'Too many project artifacts to enumerate safely.');
    const result: ArtifactManifest[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) fail('CORRUPT_METADATA', 'Unexpected manifest directory entry.');
      const record = await existing(path.join(dir, 'manifests', name), manifestSchema);
      if (!record) return fail('CORRUPT_METADATA', 'Missing enumerated manifest.');
      if (key(record.artifactPath) + '.json' !== name) {
        fail('CORRUPT_METADATA', 'Manifest file identity mismatch.');
      }
      const verified = await this.get(scope, record.artifactPath);
      if (!verified) return fail('ARTIFACT_MISSING', 'Listed artifact disappeared.');
      result.push(verified);
    }
    return result.sort((a, b) => a.artifactPath.localeCompare(b.artifactPath));
  }
  private async loadSession(scope: ArtifactScope, id: string): Promise<Session> {
    const dir = this.dir(scope);
    const session = await existing(this.sessionFile(dir, id), sessionSchema);
    if (!session) return fail('SESSION_NOT_FOUND', 'Transfer session does not exist.');
    if (session.id !== id || !equalScope(session.metadata.scope, scope)) {
      return fail('SCOPE_MISMATCH', 'Transfer belongs to a different account/project/device.');
    }
    if (session.offset > session.metadata.size || session.chunks.reduce((n, c) => n + c.size, 0) !== session.offset) {
      return fail('CORRUPT_SESSION', 'Session offset metadata is invalid.');
    }
    let pos = 0;
    const part = this.partFile(dir, id);
    try {
      if (await regularFile(part) !== session.offset) fail('CORRUPT_SESSION', 'Stage size does not match persisted offset.');
      const fd = await fs.open(part, 'r');
      try {
        for (const chunk of session.chunks) {
          if (chunk.offset !== pos) fail('CORRUPT_SESSION', 'Chunk offsets are not contiguous.');
          const bytes = Buffer.alloc(chunk.size);
          const { bytesRead } = await fd.read(bytes, 0, bytes.length, pos);
          if (bytesRead !== bytes.length || digest(bytes) !== chunk.sha256) {
            fail('CORRUPT_SESSION', 'Persisted stage differs from verified chunk receipts.');
          }
          pos += chunk.size;
        }
      } finally { await fd.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('STAGE_MISSING', 'Session metadata exists but stage is missing.');
      throw error;
    }
    return session;
  }
  async begin(input: Omit<ArtifactManifest, 'version' | 'createdAt'> & {
    expectedPreviousSha256?: string;
  }): Promise<{ state: 'ALREADY_PRESENT' | 'OPEN'; sessionId?: string; offset: number; manifest?: ArtifactManifest }> {
    const { expectedPreviousSha256: _cas, ...candidate } = input;
    const metadata = manifestSchema.parse({ ...candidate, version: 1, createdAt: new Date().toISOString() });
    const scope = metadata.scope, dir = this.dir(scope);
    const expected = input.expectedPreviousSha256 ? shaSchema.parse(input.expectedPreviousSha256) : undefined;
    return this.locked(dir, async () => {
      await this.projectGuard(scope, metadata.repository, true);
      const old = await this.checkManifest(scope, metadata.artifactPath);
      if (old && old.sha256 === metadata.sha256 && old.size === metadata.size) {
        return { state: 'ALREADY_PRESENT', offset: old.size, manifest: old };
      }
      if ((old?.sha256 ?? undefined) !== expected) {
        fail('COMPARE_AND_SWAP_FAILED', 'The expected previous SHA-256 does not match the current artifact.');
      }
      const id = key(JSON.stringify(scope), metadata.artifactPath, metadata.sha256, metadata.producerOperationId);
      await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
      const existingSession = await existing(this.sessionFile(dir, id), sessionSchema);
      if (existingSession) {
        if (existingSession.metadata.sha256 !== metadata.sha256 ||
            existingSession.metadata.size !== metadata.size ||
            existingSession.metadata.repository !== metadata.repository ||
            existingSession.metadata.commitSha !== metadata.commitSha ||
            existingSession.expectedPreviousSha256 !== expected) {
          fail('SESSION_CONFLICT', 'Transfer identity was reused with different metadata.');
        }
        const checked = await this.loadSession(scope, id);
        return { state: 'OPEN', sessionId: id, offset: checked.offset };
      }
      const session: Session = { id, metadata, offset: 0, chunks: [],
        ...(expected ? { expectedPreviousSha256: expected } : {}) };
      const fd = await fs.open(this.partFile(dir, id), 'wx', 0o600);
      await fd.close();
      await atomicJson(this.sessionFile(dir, id), session);
      return { state: 'OPEN', sessionId: id, offset: 0 };
    });
  }
  async putChunk(scope: ArtifactScope, sessionId: string, offset: number, contentBase64: string) {
    const dir = this.dir(scope), bytes = canonicalBase64(contentBase64);
    if (!Number.isSafeInteger(offset) || offset < 0) fail('OFFSET_INVALID', 'Invalid transfer offset.');
    return this.locked(dir, async () => {
      const session = await this.loadSession(scope, sessionId);
      if (offset < session.offset) {
        const prior = session.chunks.find(c => c.offset === offset && c.size === bytes.length);
        if (!prior || prior.sha256 !== digest(bytes)) fail('CHUNK_REPLAY_CONFLICT', 'Retried chunk differs from persisted bytes.');
        return { state: 'ALREADY_WRITTEN' as const, offset: session.offset };
      }
      if (offset !== session.offset || offset + bytes.length > session.metadata.size ||
          session.chunks.length >= 4096) fail('OFFSET_MISMATCH', 'Chunk offset exceeds the committed prefix or declared file size.');
      const fd = await fs.open(this.partFile(dir, sessionId), 'r+');
      try {
        const { bytesWritten } = await fd.write(bytes, 0, bytes.length, offset);
        if (bytesWritten !== bytes.length) fail('SHORT_WRITE', 'Incomplete stage write.');
        await fd.sync();
      } finally { await fd.close(); }
      session.chunks.push({ offset, size: bytes.length, sha256: digest(bytes) });
      session.offset += bytes.length;
      await atomicJson(this.sessionFile(dir, sessionId), session);
      return { state: 'WRITTEN' as const, offset: session.offset };
    });
  }
  async commit(scope: ArtifactScope, sessionId: string): Promise<ArtifactManifest> {
    const dir = this.dir(scope);
    return this.locked(dir, async () => {
      const session = await this.loadSession(scope, sessionId);
      const metadata = session.metadata, stage = this.partFile(dir, sessionId);
      if (session.offset !== metadata.size || await digestFile(stage) !== metadata.sha256) {
        return fail('HASH_MISMATCH', 'Incomplete or corrupt content cannot be committed.');
      }
      const old = await this.checkManifest(scope, metadata.artifactPath);
      if ((old?.sha256 ?? undefined) !== session.expectedPreviousSha256) {
        if (old?.sha256 === metadata.sha256 && old.size === metadata.size) return old;
        fail('COMPARE_AND_SWAP_FAILED', 'The artifact changed before finalization.');
      }
      const blob = this.objectFile(dir, metadata.sha256);
      await fs.mkdir(path.dirname(blob), { recursive: true });
      try { await fs.link(stage, blob); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (await regularFile(blob) !== metadata.size || await digestFile(blob) !== metadata.sha256) {
        fail('CORRUPT_ARTIFACT', 'Existing content-addressed object is corrupt.');
      }
      await fs.mkdir(path.join(dir, 'manifests'), { recursive: true });
      await atomicJson(this.manifestFile(dir, metadata.artifactPath), metadata);
      await fs.rm(this.sessionFile(dir, sessionId));
      await fs.rm(stage);
      return metadata;
    });
  }
  async readChunk(scope: ArtifactScope, artifactPath: string, offset: number, maxBytes = 65536) {
    const manifest = await this.get(scope, artifactPath);
    if (!manifest) return fail('ARTIFACT_NOT_FOUND', 'No verified artifact exists for this scope.');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > manifest.size ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) {
      fail('READ_RANGE_INVALID', 'Invalid artifact read range.');
    }
    const length = Math.min(maxBytes, manifest.size - offset);
    const buf = Buffer.alloc(length);
    const fd = await fs.open(this.objectFile(this.dir(scope), manifest.sha256), 'r');
    try {
      const { bytesRead } = await fd.read(buf, 0, buf.length, offset);
      if (bytesRead !== length) fail('ARTIFACT_CHANGED', 'Artifact was truncated during read.');
    } finally { await fd.close(); }
    return { artifactPath, offset, size: length, totalSize: manifest.size,
      sha256: manifest.sha256, chunkSha256: digest(buf), contentBase64: buf.toString('base64') };
  }
  async saveCheckpoint(input: Omit<ArtifactCheckpoint, 'version' | 'artifacts' | 'updatedAt'> & {
    artifactPaths: string[];
  }): Promise<ArtifactCheckpoint> {
    scopeSchema.parse(input.scope);
    const dir = this.dir(input.scope);
    return this.locked(dir, async () => {
      await this.projectGuard(input.scope, input.repository, true);
      if (input.artifactPaths.length > 128 || new Set(input.artifactPaths).size !== input.artifactPaths.length) {
        fail('INVALID_CHECKPOINT', 'Artifact references must be unique and bounded.');
      }
      const artifacts: ArtifactManifest[] = [];
      for (const p of input.artifactPaths) {
        const artifact = await this.get(input.scope, p);
        if (!artifact) return fail('ARTIFACT_MISSING', 'Checkpoint references a missing artifact.');
        if (artifact.repository !== input.repository || artifact.commitSha !== input.commitSha) {
          fail('CHECKPOINT_PROVENANCE_MISMATCH', 'Artifact repository/commit does not match checkpoint.');
        }
        artifacts.push(artifact);
      }
      const { artifactPaths: _referenced, ...snapshot } = input;
      const checkpoint = checkpointSchema.parse({
        ...snapshot, version: 1, artifacts, updatedAt: new Date().toISOString(),
      });
      await fs.mkdir(path.join(dir, 'checkpoints'), { recursive: true });
      await atomicJson(path.join(dir, 'checkpoints', key(checkpoint.workspaceId) + '.json'), checkpoint);
      return checkpoint;
    });
  }
  async listCheckpoints(scope: ArtifactScope): Promise<ArtifactCheckpoint[]> {
    const dir = this.dir(scope);
    let entries: string[];
    try { entries = await fs.readdir(path.join(dir, 'checkpoints')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (entries.length > 10000) fail('LIST_LIMIT', 'Too many project checkpoints.');
    const results: ArtifactCheckpoint[] = [];
    for (const file of entries) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) fail('CORRUPT_METADATA', 'Unexpected checkpoint file.');
      const raw = await existing(path.join(dir, 'checkpoints', file), checkpointSchema);
      if (!raw) return fail('CORRUPT_METADATA', 'Missing enumerated checkpoint.');
      if (key(raw.workspaceId) + '.json' !== file) fail('CORRUPT_METADATA', 'Checkpoint identity mismatch.');
      const verified = await this.getCheckpoint(scope, raw.workspaceId);
      if (!verified) return fail('CHECKPOINT_MISSING', 'Listed checkpoint was removed.');
      results.push(verified);
    }
    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getCheckpoint(scope: ArtifactScope, workspaceId: string): Promise<ArtifactCheckpoint | null> {
    const dir = this.dir(scope);
    const checkpoint = await existing(path.join(dir, 'checkpoints',
      key(identity.parse(workspaceId)) + '.json'), checkpointSchema);
    if (!checkpoint) return null;
    if (!equalScope(checkpoint.scope, scope) || checkpoint.workspaceId !== workspaceId) {
      fail('SCOPE_MISMATCH', 'Checkpoint scope mismatch.');
    }
    for (const expected of checkpoint.artifacts) {
      const actual = await this.get(scope, expected.artifactPath);
      if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
        fail('CHECKPOINT_ARTIFACT_CHANGED', 'Checkpoint artifact was removed or replaced.');
      }
    }
    return checkpoint;
  }
}
