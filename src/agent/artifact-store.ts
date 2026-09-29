import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import type { PathPolicy } from './path-policy.js';

const ArtifactKindSchema = z.enum([
  'build',
  'test',
  'report',
  'log',
  'package',
  'archive',
  'image',
  'binary',
  'other',
]);

const ArtifactRecordSchema = z.object({
  id: z.string().uuid(),
  path: z.string().min(1).max(4096),
  label: z.string().min(1).max(256).optional(),
  kind: ArtifactKindSchema,
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  modifiedAt: z.string().datetime(),
  registeredAt: z.string().datetime(),
  sourceGraphId: z.string().min(1).max(128).optional(),
  sourceJobId: z.string().min(1).max(128).optional(),
});

const StateSchema = z.object({
  version: z.literal(1),
  artifacts: z.array(ArtifactRecordSchema).max(10_000),
});

export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

export class ArtifactStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

async function sha256File(
  target: string,
  maxBytes: number,
): Promise<{ sha256: string; size: number; modifiedAt: string }> {
  const stat = await fs.stat(target);
  if (!stat.isFile()) {
    throw new ArtifactStoreError(
      'ARTIFACT_NOT_FILE',
      'Artifact tracking currently supports files only.',
      { path: target },
    );
  }
  if (stat.size > maxBytes) {
    throw new ArtifactStoreError(
      'ARTIFACT_TOO_LARGE',
      'Artifact exceeds max_hash_bytes.',
      {
        path: target,
        size: stat.size,
        maxHashBytes: maxBytes,
      },
    );
  }

  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });

  return {
    sha256: hash.digest('hex'),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

export interface ArtifactStoreOptions {
  stateFile: string;
  maxRecords?: number;
}

export class ArtifactStore {
  private readonly stateFile: string;
  private readonly maxRecords: number;
  private readonly records = new Map<string, ArtifactRecord>();
  private loaded = false;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: ArtifactStoreOptions) {
    this.stateFile = options.stateFile;
    this.maxRecords = options.maxRecords ?? 5_000;
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    try {
      const decoded = StateSchema.parse(
        JSON.parse(await fs.readFile(this.stateFile, 'utf8')),
      );
      for (const record of decoded.artifacts) {
        this.records.set(record.id, record);
      }
      this.trim();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      this.loaded = false;
      throw error;
    }
  }

  async register(
    input: {
      path: string;
      label?: string;
      kind?: ArtifactKind;
      sourceGraphId?: string;
      sourceJobId?: string;
      maxHashBytes?: number;
    },
    policy: PathPolicy,
    cwd = process.cwd(),
  ): Promise<ArtifactRecord> {
    await this.initialize();
    const target = await policy.resolveExisting(input.path, cwd);
    const maxHashBytes = Math.min(
      4_294_967_296,
      Math.max(1, input.maxHashBytes ?? 536_870_912),
    );
    const metadata = await sha256File(target, maxHashBytes);
    const now = new Date().toISOString();

    const record = ArtifactRecordSchema.parse({
      id: randomUUID(),
      path: target,
      ...(input.label ? { label: input.label } : {}),
      kind: input.kind ?? 'other',
      ...metadata,
      registeredAt: now,
      ...(input.sourceGraphId
        ? { sourceGraphId: input.sourceGraphId }
        : {}),
      ...(input.sourceJobId
        ? { sourceJobId: input.sourceJobId }
        : {}),
    });

    this.records.set(record.id, record);
    this.trim();
    await this.persist();
    return { ...record };
  }

  async list(input: {
    graphId?: string;
    jobId?: string;
    kind?: ArtifactKind;
    limit?: number;
  } = {}): Promise<ArtifactRecord[]> {
    await this.initialize();
    const limit = Math.max(1, Math.min(1000, input.limit ?? 200));

    return [...this.records.values()]
      .filter(
        (record) =>
          (!input.graphId ||
            record.sourceGraphId === input.graphId) &&
          (!input.jobId || record.sourceJobId === input.jobId) &&
          (!input.kind || record.kind === input.kind),
      )
      .sort(
        (a, b) =>
          b.registeredAt.localeCompare(a.registeredAt) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }

  async get(id: string): Promise<ArtifactRecord> {
    await this.initialize();
    const record = this.records.get(id);
    if (!record) {
      throw new ArtifactStoreError(
        'ARTIFACT_NOT_FOUND',
        'Unknown artifact record.',
        { id },
      );
    }
    return { ...record };
  }

  async verify(
    id: string,
    policy: PathPolicy,
    maxHashBytes = 536_870_912,
  ): Promise<{
    artifact: ArtifactRecord;
    exists: boolean;
    matches: boolean;
    current?: {
      size: number;
      sha256: string;
      modifiedAt: string;
    };
  }> {
    const artifact = await this.get(id);

    let target: string;
    try {
      target = await policy.resolveExisting(artifact.path);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { artifact, exists: false, matches: false };
      }
      throw error;
    }

    try {
      const current = await sha256File(
        target,
        Math.min(
          4_294_967_296,
          Math.max(1, maxHashBytes),
        ),
      );
      return {
        artifact,
        exists: true,
        matches:
          current.sha256 === artifact.sha256 &&
          current.size === artifact.size,
        current,
      };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { artifact, exists: false, matches: false };
      }
      throw error;
    }
  }

  async prune(input: {
    olderThanMs?: number;
    removeMissing?: boolean;
    policy?: PathPolicy;
  } = {}): Promise<{ removed: number; remaining: number }> {
    await this.initialize();
    const cutoff =
      input.olderThanMs === undefined
        ? undefined
        : Date.now() - Math.max(0, input.olderThanMs);
    let removed = 0;

    for (const [id, record] of this.records) {
      let shouldRemove =
        cutoff !== undefined &&
        Date.parse(record.registeredAt) <= cutoff;

      if (!shouldRemove && input.removeMissing) {
        if (!input.policy) {
          throw new ArtifactStoreError(
            'ARTIFACT_POLICY_REQUIRED',
            'remove_missing requires a path policy.',
          );
        }
        try {
          await input.policy.resolveExisting(record.path);
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
          ) {
            shouldRemove = true;
          } else {
            throw error;
          }
        }
      }

      if (shouldRemove) {
        this.records.delete(id);
        removed++;
      }
    }

    if (removed > 0) await this.persist();
    return { removed, remaining: this.records.size };
  }

  private trim(): void {
    if (this.records.size <= this.maxRecords) return;
    const excess = [...this.records.values()]
      .sort((a, b) =>
        a.registeredAt.localeCompare(b.registeredAt),
      )
      .slice(0, this.records.size - this.maxRecords);
    for (const record of excess) {
      this.records.delete(record.id);
    }
  }

  private async persist(): Promise<void> {
    const snapshot = StateSchema.parse({
      version: 1,
      artifacts: [...this.records.values()].sort((a, b) =>
        a.registeredAt.localeCompare(b.registeredAt),
      ),
    });

    this.persistChain = this.persistChain.catch(() => undefined).then(
      async () => {
        await fs.mkdir(path.dirname(this.stateFile), {
          recursive: true,
        });
        const temp = this.stateFile + '.tmp';
        await fs.writeFile(
          temp,
          JSON.stringify(snapshot, null, 2) + '\n',
          'utf8',
        );
        await fs.rename(temp, this.stateFile);
      },
    );
    await this.persistChain;
  }
}
