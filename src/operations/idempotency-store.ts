import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';
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
  records: z.array(RecordSchema),
});

export type IdempotencyRecord = z.infer<typeof RecordSchema>;

// Same-process store instances share an incarnation. A second Hub process,
// including one on a different host using a shared journal, must not claim
// the same SQLite anti-replay authority while its prior writer is live.
const HUB_WRITER = Object.freeze({
  host: hostname(),
  pid: process.pid,
  incarnation: randomUUID(),
});


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

/**
 * Persistent Hub reservation ledger backed by SQLite WAL.
 *
 * There is no arbitrary production record-count limit. Keys, fingerprints,
 * UUIDs and terminal/UNKNOWN statuses are durable anti-replay tombstones.
 * A finite maxRecords constructor option exists only for isolated quota tests.
 *
 * Legacy v1 JSON is migrated atomically, kept untouched as an operator backup,
 * and checked for concurrent legacy-writer drift on every initialize.
 */
export class IdempotencyStore {
  private loaded = false;
  private loading?: Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly cachedResults = new Map<string, unknown>();
  private readonly maxCachedResults = 256;

  constructor(
    private readonly rootDir: string,
    private readonly maxRecords?: number,
  ) {
    if (
      maxRecords !== undefined &&
      (!Number.isSafeInteger(maxRecords) || maxRecords < 1)
    ) {
      throw new IdempotencyStoreError(
        'IDEMPOTENCY_CAPACITY_INVALID',
        'An explicit test-only Hub capacity must be a positive safe integer.',
      );
    }
  }

  private get legacyFile(): string {
    return path.join(this.rootDir, 'idempotency-records.json');
  }

  private get sqliteFile(): string {
    return path.join(this.rootDir, 'idempotency-records.sqlite');
  }

  private openDb(): DatabaseSync {
    const db = new DatabaseSync(this.sqliteFile);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('PRAGMA synchronous=FULL');
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private static readonly columns =
    'key, fingerprint, operation_id AS operationId, capability, ' +
    'target_id AS targetId, status, created_at AS createdAt, ' +
    'updated_at AS updatedAt';

  private getRecord(db: DatabaseSync, key: string): IdempotencyRecord | undefined {
    const row = db.prepare(
      'SELECT ' + IdempotencyStore.columns +
      ' FROM idempotency_records WHERE key=?',
    ).get(key);
    return row === undefined ? undefined : RecordSchema.parse(row);
  }

  private withDatabase<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.openDb();
    try {
      return fn(db);
    } finally {
      // Do not leave Win32 file handles open between calls or tests.
      db.close();
    }
  }

  // The startup ownership claim must remain valid for *every* mutation.
  // An out-of-band owner handoff (or an accidental second Hub) must not
  // leave an already-initialized writer free to append to a foreign ledger.
  private assertHubWriterOwnership(db: DatabaseSync): void {
    const row = db.prepare(
      "SELECT value FROM idempotency_meta WHERE key='hub_writer'",
    ).get() as { value: string } | undefined;
    if (row?.value !== JSON.stringify(HUB_WRITER)) {
      throw new IdempotencyStoreError(
        'IDEMPOTENCY_HUB_WRITER_LOST',
        'The Hub SQLite journal is no longer owned by this process incarnation.',
      );
    }
  }

  private withTransaction<T>(fn: (db: DatabaseSync) => T): T {
    return this.withDatabase((db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        this.assertHubWriterOwnership(db);
        const result = fn(db);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* retain original failure */ }
        throw error;
      }
    });
  }

  private claimExclusiveHubProcess(db: DatabaseSync): void {
    const row = db.prepare(
      "SELECT value FROM idempotency_meta WHERE key='hub_writer'",
    ).get() as { value: string } | undefined;
    if (row) {
      let old: unknown;
      try { old = JSON.parse(row.value); } catch { /* deny corrupt owner */ }
      if (!old || typeof old !== 'object' || Array.isArray(old)) {
        throw new IdempotencyStoreError(
          'IDEMPOTENCY_WRITER_INVALID',
          'The previous Hub journal owner identity is invalid.',
        );
      }
      const owner = old as Record<string, unknown>;
      if (typeof owner.host !== 'string' ||
          typeof owner.pid !== 'number' ||
          !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
          typeof owner.incarnation !== 'string' || !owner.incarnation) {
        throw new IdempotencyStoreError(
          'IDEMPOTENCY_WRITER_INVALID',
          'The previous Hub journal owner identity is invalid.',
        );
      }
      if (owner.host !== HUB_WRITER.host) {
        throw new IdempotencyStoreError(
          'IDEMPOTENCY_CROSS_HOST_JOURNAL_DENIED',
          'A journal owned by another host cannot be claimed automatically.',
        );
      }
      if (owner.pid !== HUB_WRITER.pid ||
          owner.incarnation !== HUB_WRITER.incarnation) {
        // An occupied PID (including a recycled one) cannot be distinguished
        // safely from the old process. Fail closed rather than split authority.
        let previousProcessAlive = true;
        try { process.kill(owner.pid, 0); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error &&
              error.code === 'ESRCH') previousProcessAlive = false;
        }
        if (previousProcessAlive) {
          throw new IdempotencyStoreError(
            'IDEMPOTENCY_HUB_WRITER_ACTIVE',
            'Another live Hub process already owns this SQLite journal.',
          );
        }
      }
    }
    db.prepare(
      "INSERT INTO idempotency_meta (key, value) VALUES ('hub_writer', ?) " +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(JSON.stringify(HUB_WRITER));
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      await fs.mkdir(this.rootDir, { recursive: true });
      let legacyContent: string | undefined;
      try {
        legacyContent = await fs.readFile(this.legacyFile, 'utf8');
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error &&
          error.code === 'ENOENT')) throw error;
      }

      // Validate the complete historical file before creating or changing
      // the SQLite ledger. Never discard malformed legacy reservations.
      const legacy = legacyContent === undefined
        ? undefined
        : FileSchema.parse(JSON.parse(legacyContent)).records;
      const legacyHash = legacyContent === undefined
        ? undefined
        : createHash('sha256').update(legacyContent, 'utf8').digest('hex');

      this.withDatabase((db) => {
        db.exec('PRAGMA journal_mode=WAL');
        db.exec(`
          CREATE TABLE IF NOT EXISTS idempotency_records (
            key TEXT PRIMARY KEY NOT NULL,
            fingerprint TEXT NOT NULL,
            operation_id TEXT NOT NULL UNIQUE,
            capability TEXT NOT NULL,
            target_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN
              ('in_progress', 'succeeded', 'failed', 'unknown')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS idempotency_operation_idx
            ON idempotency_records(operation_id);
          CREATE INDEX IF NOT EXISTS idempotency_updated_idx
            ON idempotency_records(updated_at DESC);
          CREATE INDEX IF NOT EXISTS idempotency_device_updated_idx
            ON idempotency_records(target_id, updated_at DESC);
          CREATE TABLE IF NOT EXISTS idempotency_meta (
            key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL
          ) STRICT;
        `);
        const check = db.prepare('PRAGMA quick_check').get() as
          | { quick_check?: string } | undefined;
        if (check?.quick_check !== 'ok') {
          throw new IdempotencyStoreError(
            'IDEMPOTENCY_STORE_CORRUPT',
            'SQLite idempotency integrity verification failed; refusing mutation.',
          );
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          const schema = db.prepare(
            "SELECT value FROM idempotency_meta WHERE key='schema_version'",
          ).get() as { value: string } | undefined;
          const recordedHash = db.prepare(
            "SELECT value FROM idempotency_meta WHERE key='legacy_sha256'",
          ).get() as { value: string } | undefined;
          if (schema && schema.value !== '1') {
            throw new IdempotencyStoreError(
              'IDEMPOTENCY_STORE_SCHEMA_UNSUPPORTED',
              'Unknown idempotency schema; refusing mutation.',
            );
          }

          this.claimExclusiveHubProcess(db);

          if (!schema) {
            const existingCount = db.prepare(
              'SELECT COUNT(*) AS count FROM idempotency_records',
            ).get() as { count: number };
            if (existingCount.count !== 0 || recordedHash) {
              throw new IdempotencyStoreError(
                'IDEMPOTENCY_STORE_MIGRATION_INCOMPLETE',
                'Existing reservation rows without a committed schema marker.',
              );
            }
            if (legacy) {
              const insert = db.prepare(`
                INSERT INTO idempotency_records
                  (key, fingerprint, operation_id, capability, target_id,
                   status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `);
              for (const item of legacy) {
                insert.run(item.key, item.fingerprint, item.operationId,
                  item.capability, item.targetId, item.status,
                  item.createdAt, item.updatedAt);
              }
              db.prepare(
                "INSERT INTO idempotency_meta (key, value) VALUES ('legacy_sha256', ?)",
              ).run(legacyHash!);
            }
            db.prepare(
              "INSERT INTO idempotency_meta (key, value) VALUES ('schema_version', '1')",
            ).run();
          } else if (
            (recordedHash?.value !== undefined &&
              legacyHash !== recordedHash.value) ||
            (recordedHash === undefined && legacyContent !== undefined)
          ) {
            // An old Hub binary may still be writing the JSON snapshot.
            // Continuing would silently fork the anti-replay authority.
            throw new IdempotencyStoreError(
              'IDEMPOTENCY_LEGACY_JOURNAL_DRIFT',
              'Legacy journal changed or appeared after SQLite migration; refusing mutation.',
            );
          }

          if (this.maxRecords !== undefined) {
            const { count } = db.prepare(
              'SELECT COUNT(*) AS count FROM idempotency_records',
            ).get() as { count: number };
            if (count > this.maxRecords) {
              throw new IdempotencyStoreError(
                'IDEMPOTENCY_STORE_FULL',
                'Explicit test capacity exhausted; no key can be safely evicted.',
              );
            }
          }

          // Crash recovery cannot attest external effects. Conservatively
          // fence all abandoned reservations as UNKNOWN, never FAILED.
          db.prepare(`
            UPDATE idempotency_records
            SET status='unknown', updated_at=?
            WHERE status='in_progress'
          `).run(new Date().toISOString());

          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* keep first exception */ }
          throw error;
        }
      });
    })();
    try {
      await this.loading;
      this.loaded = true;
    } finally {
      this.loading = undefined;
    }
  }

  // Serialize callers in this instance; SQLite BEGIN IMMEDIATE also
  // serializes reservations from other instances/processes.
  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await fn(); } finally { release(); }
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
    return this.mutate(async () => this.withTransaction((db) => {
      const key = validateIdempotencyKey(input.key);
      const existing = this.getRecord(db, key);
      if (existing) {
        if (existing.fingerprint !== input.fingerprint ||
            existing.targetId !== input.targetId ||
            existing.capability !== input.capability) {
          throw new IdempotencyStoreError(
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency key already reserved for a different operation.',
            { key, existingOperationId: existing.operationId,
              existingCapability: existing.capability,
              existingTargetId: existing.targetId },
          );
        }
        return {
          created: false as const,
          record: existing,
          ...(this.cachedResults.has(key)
            ? { cachedResult: this.cachedResults.get(key) } : {}),
        };
      }
      if (this.maxRecords !== undefined) {
        const { count } = db.prepare(
          'SELECT COUNT(*) AS count FROM idempotency_records',
        ).get() as { count: number };
        if (count >= this.maxRecords) {
          throw new IdempotencyStoreError(
            'IDEMPOTENCY_STORE_FULL',
            'Explicit test capacity exhausted; no prior key can be evicted.',
          );
        }
      }
      const now = new Date().toISOString();
      const record = RecordSchema.parse({
        key, fingerprint: input.fingerprint,
        operationId: randomUUID(), capability: input.capability,
        targetId: input.targetId, status: 'in_progress',
        createdAt: now, updatedAt: now,
      });
      db.prepare(`
        INSERT INTO idempotency_records
          (key, fingerprint, operation_id, capability, target_id,
           status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.key, record.fingerprint, record.operationId,
        record.capability, record.targetId, record.status,
        record.createdAt, record.updatedAt);
      return { created: true as const, record };
    }));
  }

  async complete(
    keyInput: string,
    status: Exclude<IdempotencyStatus, 'in_progress'>,
    cachedResult?: unknown,
  ): Promise<IdempotencyRecord> {
    await this.initialize();
    return this.mutate(async () => {
      const record = this.withTransaction((db) => {
        const key = validateIdempotencyKey(keyInput);
        const existing = this.getRecord(db, key);
        if (!existing) {
          throw new IdempotencyStoreError(
            'IDEMPOTENCY_RECORD_NOT_FOUND',
            'Idempotency operation record does not exist.', { key },
          );
        }
        // A terminal status, especially UNKNOWN after restart, is an
        // anti-replay witness. A stale completion must not rewrite it.
        // Trusted external reconciliation needs a separate proof-bound API.
        if (existing.status !== 'in_progress') {
          throw new IdempotencyStoreError(
            'IDEMPOTENCY_TERMINAL_REWRITE_DENIED',
            'A terminal reservation cannot be completed again.',
            { key, operationId: existing.operationId, status: existing.status },
          );
        }
        const updated = RecordSchema.parse({
          ...existing, status, updatedAt: new Date().toISOString(),
        });
        db.prepare(`
          UPDATE idempotency_records
          SET status=?, updated_at=? WHERE key=?
        `).run(updated.status, updated.updatedAt, key);
        return updated;
      });
      // Cached tool output is strictly optional and never persisted. LRU
      // bounds memory use without retiring any anti-replay tombstone.
      this.cachedResults.delete(record.key);
      if (cachedResult !== undefined) {
        this.cachedResults.set(record.key, cachedResult);
        if (this.cachedResults.size > this.maxCachedResults) {
          const oldest = this.cachedResults.keys().next().value;
          if (oldest !== undefined) this.cachedResults.delete(oldest);
        }
      }
      return record;
    });
  }

  async get(keyInput: string): Promise<IdempotencyRecord | undefined> {
    await this.initialize();
    await this.mutationQueue;
    return this.withDatabase((db) => {
      const record = this.getRecord(db, validateIdempotencyKey(keyInput));
      return record ? { ...record } : undefined;
    });
  }

  async getByOperationId(operationId: string): Promise<IdempotencyRecord | undefined> {
    await this.initialize();
    const id = z.string().uuid().parse(operationId);
    await this.mutationQueue;
    return this.withDatabase((db) => {
      const row = db.prepare(
        'SELECT ' + IdempotencyStore.columns +
        ' FROM idempotency_records WHERE operation_id=?',
      ).get(id);
      return row === undefined ? undefined : RecordSchema.parse(row);
    });
  }

  async list(
    limit = 100,
    allowedDeviceIds?: ReadonlySet<string>,
  ): Promise<IdempotencyRecord[]> {
    await this.initialize();
    await this.mutationQueue;
    const safeLimit = Math.max(1, Math.min(limit, 500));
    return this.withDatabase((db) => {
      if (allowedDeviceIds === undefined) {
        return db.prepare(
          'SELECT ' + IdempotencyStore.columns +
          ' FROM idempotency_records ORDER BY updated_at DESC LIMIT ?',
        ).all(safeLimit).map((item) => RecordSchema.parse(item));
      }
      const allowed = [...allowedDeviceIds];
      if (allowed.length === 0) return [];
      // Split filters to stay under SQLite's bounded parameter count.
      // Filter before sorting/limiting so foreign-device records cannot
      // hide older records in the caller's authorized scope.
      const rows: IdempotencyRecord[] = [];
      for (let i = 0; i < allowed.length; i += 256) {
        const batch = allowed.slice(i, i + 256);
        const sql =
          'SELECT ' + IdempotencyStore.columns +
          ' FROM idempotency_records WHERE target_id IN (' +
          batch.map(() => '?').join(',') +
          ') ORDER BY updated_at DESC LIMIT ?';
        rows.push(...db.prepare(sql).all(...batch, safeLimit)
          .map((item) => RecordSchema.parse(item)));
      }
      return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, safeLimit);
    });
  }
}
