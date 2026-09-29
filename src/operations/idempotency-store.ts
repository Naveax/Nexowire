import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

export type IdempotencyStatus =
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'unknown';

const KeySchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/);

const RecordSchema = z.object({
  key: KeySchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().uuid(),
  capability: z.string().min(1).max(256),
  targetId: z.string().min(1).max(128),
  status: z.enum(['in_progress', 'succeeded', 'failed', 'unknown']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const FileSchema = z.object({
  version: z.literal(1),
  records: z.array(RecordSchema).max(5000),
});

export type IdempotencyRecord = z.infer<typeof RecordSchema>;

export class IdempotencyStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'IdempotencyStoreError';
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function operationFingerprint(input: {
  targetId: string;
  capability: string;
  providerId?: string;
  payload: unknown;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalize({
          targetId: input.targetId,
          capability: input.capability,
          providerId: input.providerId ?? null,
          payload: input.payload,
        }),
      ),
      'utf8',
    )
    .digest('hex');
}

export function validateIdempotencyKey(key: string): string {
  return KeySchema.parse(key);
}

export class IdempotencyStore {
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly cachedResults = new Map<string, unknown>();

  constructor(
    private readonly rootDir: string,
    private readonly maxRecords = 2000,
  ) {}

  private get file(): string {
    return path.join(this.rootDir, 'idempotency-records.json');
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const decoded = FileSchema.parse(
        JSON.parse(await fs.readFile(this.file, 'utf8')),
      );
      let changed = false;
      for (const loaded of decoded.records) {
        const record =
          loaded.status === 'in_progress'
            ? {
                ...loaded,
                status: 'unknown' as const,
                updatedAt: new Date().toISOString(),
              }
            : loaded;
        if (record.status !== loaded.status) changed = true;
        this.records.set(record.key, record);
      }
      this.trim();
      if (changed) await this.persist();
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

  async begin(input: {
    key: string;
    fingerprint: string;
    capability: string;
    targetId: string;
  }): Promise<
    | { created: true; record: IdempotencyRecord }
    | { created: false; record: IdempotencyRecord; cachedResult?: unknown }
  > {
    await this.initialize();
    const key = validateIdempotencyKey(input.key);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) {
        throw new IdempotencyStoreError(
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency key was already used for a different operation fingerprint.',
          {
            key,
            existingOperationId: existing.operationId,
            existingCapability: existing.capability,
            existingTargetId: existing.targetId,
          },
        );
      }
      return {
        created: false,
        record: existing,
        ...(this.cachedResults.has(key)
          ? { cachedResult: this.cachedResults.get(key) }
          : {}),
      };
    }

    const now = new Date().toISOString();
    const record = RecordSchema.parse({
      key,
      fingerprint: input.fingerprint,
      operationId: randomUUID(),
      capability: input.capability,
      targetId: input.targetId,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });
    this.records.set(key, record);
    this.trim();
    await this.persist();
    return { created: true, record };
  }

  async complete(
    keyInput: string,
    status: Exclude<IdempotencyStatus, 'in_progress'>,
    cachedResult?: unknown,
  ): Promise<IdempotencyRecord> {
    await this.initialize();
    const key = validateIdempotencyKey(keyInput);
    const existing = this.records.get(key);
    if (!existing) {
      throw new IdempotencyStoreError(
        'IDEMPOTENCY_RECORD_NOT_FOUND',
        'Idempotency operation record does not exist.',
        { key },
      );
    }

    const record = RecordSchema.parse({
      ...existing,
      status,
      updatedAt: new Date().toISOString(),
    });
    this.records.set(key, record);
    if (cachedResult !== undefined) {
      this.cachedResults.set(key, cachedResult);
    } else {
      this.cachedResults.delete(key);
    }
    await this.persist();
    return record;
  }

  async list(limit = 100): Promise<IdempotencyRecord[]> {
    await this.initialize();
    const safeLimit = Math.max(1, Math.min(limit, 500));
    return [...this.records.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, safeLimit);
  }

  private trim(): void {
    if (this.records.size <= this.maxRecords) return;
    const oldest = [...this.records.values()]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, this.records.size - this.maxRecords);
    for (const record of oldest) {
      this.records.delete(record.key);
      this.cachedResults.delete(record.key);
    }
  }

  private async persist(): Promise<void> {
    const payload = FileSchema.parse({
      version: 1,
      records: [...this.records.values()].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      ),
    });

    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await fs.mkdir(this.rootDir, { recursive: true });
      const temp = this.file + '.tmp';
      await fs.writeFile(
        temp,
        JSON.stringify(payload, null, 2) + '\n',
        'utf8',
      );
      await fs.rename(temp, this.file);
    });
    await this.writeChain;
  }
}
