import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

export const CredentialScopeSchema = z.enum(['mcp', 'agent']);
export type CredentialScope = z.infer<typeof CredentialScopeSchema>;

const IdSchema = z
  .string()
  .min(12)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

const RecordSchema = z.object({
  id: IdSchema,
  scope: CredentialScopeSchema,
  name: z.string().min(1).max(128).optional(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
});

const StateSchema = z.object({
  version: z.literal(1),
  credentials: z.array(RecordSchema).max(10_000),
});

type StoredCredential = z.infer<typeof RecordSchema>;

export interface CredentialMetadata {
  id: string;
  scope: CredentialScope;
  name?: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface CredentialStoreOptions {
  now?: () => number;
}

export class CredentialStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CredentialStoreError';
  }
}

function metadata(record: StoredCredential): CredentialMetadata {
  return {
    id: record.id,
    scope: record.scope,
    ...(record.name ? { name: record.name } : {}),
    createdAt: record.createdAt,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
  };
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function parseToken(
  token: string,
): { scope: CredentialScope; id: string } | undefined {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'nwx1') return undefined;
  const scope = CredentialScopeSchema.safeParse(parts[1]);
  const id = IdSchema.safeParse(parts[2]);
  const secret = parts[3];
  if (
    !scope.success ||
    !id.success ||
    !secret ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(secret)
  ) {
    return undefined;
  }
  return { scope: scope.data, id: id.data };
}

export class CredentialStore {
  private readonly records = new Map<string, StoredCredential>();
  private loaded = false;
  private lastMtimeMs = -1;
  private lastSize = -1;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly rootDir: string,
    options: CredentialStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  private get file(): string {
    return path.join(this.rootDir, 'credentials.json');
  }

  private get lockFile(): string {
    return path.join(this.rootDir, 'credentials.lock');
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(this.rootDir, { recursive: true });
    await this.reloadFromDisk();
    this.loaded = true;
  }

  list(input: {
    scope?: CredentialScope;
    includeRevoked?: boolean;
  } = {}): CredentialMetadata[] {
    this.refreshIfChangedSync();
    return [...this.records.values()]
      .filter(
        (record) =>
          (!input.scope || record.scope === input.scope) &&
          (input.includeRevoked || !record.revokedAt),
      )
      .map(metadata)
      .sort(
        (a, b) =>
          a.scope.localeCompare(b.scope) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
  }

  hasUsable(scope: CredentialScope): boolean {
    this.refreshIfChangedSync();
    const now = this.now();
    return [...this.records.values()].some(
      (record) =>
        record.scope === scope &&
        !record.revokedAt &&
        (!record.expiresAt ||
          Date.parse(record.expiresAt) > now),
    );
  }

  verify(scope: CredentialScope, token: string | undefined): boolean {
    if (!token) return false;
    this.refreshIfChangedSync();

    const parsed = parseToken(token);
    if (!parsed || parsed.scope !== scope) return false;
    const record = this.records.get(parsed.id);
    if (
      !record ||
      record.scope !== scope ||
      record.revokedAt ||
      (record.expiresAt &&
        Date.parse(record.expiresAt) <= this.now())
    ) {
      return false;
    }

    const candidate = hashToken(token);
    const expected = Buffer.from(record.tokenHash, 'hex');
    return (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    );
  }

  async issue(
    scopeInput: CredentialScope,
    input: {
      name?: string;
      ttlMs?: number;
    } = {},
  ): Promise<{
    credential: CredentialMetadata;
    token: string;
  }> {
    const scope = CredentialScopeSchema.parse(scopeInput);
    const name = input.name?.trim();
    if (name !== undefined && (name.length < 1 || name.length > 128)) {
      throw new CredentialStoreError(
        'CREDENTIAL_NAME_INVALID',
        'Credential name must be 1-128 characters.',
      );
    }
    if (
      input.ttlMs !== undefined &&
      (!Number.isInteger(input.ttlMs) ||
        input.ttlMs < 1_000 ||
        input.ttlMs > 31_536_000_000)
    ) {
      throw new CredentialStoreError(
        'CREDENTIAL_TTL_INVALID',
        'Credential ttlMs must be between 1 second and 365 days.',
      );
    }

    const id = randomBytes(12).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const token = `nwx1.${scope}.${id}.${secret}`;
    const now = this.now();
    const record = RecordSchema.parse({
      id,
      scope,
      ...(name ? { name } : {}),
      tokenHash: hashToken(token).toString('hex'),
      createdAt: new Date(now).toISOString(),
      ...(input.ttlMs !== undefined
        ? {
            expiresAt: new Date(
              now + input.ttlMs,
            ).toISOString(),
          }
        : {}),
    });

    await this.mutate(async () => {
      if (this.records.has(id)) {
        throw new CredentialStoreError(
          'CREDENTIAL_ID_COLLISION',
          'Generated credential ID already exists.',
        );
      }
      this.records.set(id, record);
    });

    return {
      credential: metadata(record),
      token,
    };
  }

  async revoke(idInput: string): Promise<CredentialMetadata> {
    const id = IdSchema.parse(idInput);
    let updated: StoredCredential | undefined;

    await this.mutate(async () => {
      const current = this.records.get(id);
      if (!current) {
        throw new CredentialStoreError(
          'CREDENTIAL_NOT_FOUND',
          'Credential was not found.',
          { id },
        );
      }
      updated = RecordSchema.parse({
        ...current,
        revokedAt:
          current.revokedAt ??
          new Date(this.now()).toISOString(),
      });
      this.records.set(id, updated);
    });

    return metadata(updated!);
  }

  private async mutate(
    operation: () => Promise<void> | void,
  ): Promise<void> {
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const release = await this.acquireLock();
        try {
          await this.reloadFromDisk();
          await operation();
          await this.persist();
        } finally {
          await release();
        }
      });
    await this.writeChain;
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const deadline = Date.now() + 5_000;

    while (true) {
      try {
        const handle = await fs.open(this.lockFile, 'wx', 0o600);
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString(),
          }),
          'utf8',
        );
        await handle.close();
        return async () => {
          await fs.rm(this.lockFile, { force: true });
        };
      } catch (error) {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== 'EEXIST'
        ) {
          throw error;
        }

        try {
          const stat = await fs.stat(this.lockFile);
          if (Date.now() - stat.mtimeMs > 30_000) {
            await fs.rm(this.lockFile, { force: true });
            continue;
          }
        } catch {
          continue;
        }

        if (Date.now() >= deadline) {
          throw new CredentialStoreError(
            'CREDENTIAL_STORE_BUSY',
            'Timed out waiting for credential-store lock.',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  private async reloadFromDisk(): Promise<void> {
    try {
      const decoded = StateSchema.parse(
        JSON.parse(await fs.readFile(this.file, 'utf8')),
      );
      this.records.clear();
      for (const record of decoded.credentials) {
        this.records.set(record.id, record);
      }
      const stat = await fs.stat(this.file);
      this.lastMtimeMs = stat.mtimeMs;
      this.lastSize = stat.size;
      this.lastSize = stat.size;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        this.records.clear();
        this.lastMtimeMs = -1;
        this.lastSize = -1;
        return;
      }
      throw error;
    }
  }

  private refreshIfChangedSync(): void {
    if (!this.loaded) return;
    try {
      const stat = statSync(this.file);
      if (
        stat.mtimeMs === this.lastMtimeMs &&
        stat.size === this.lastSize
      ) {
        return;
      }
      const decoded = StateSchema.parse(
        JSON.parse(readFileSync(this.file, 'utf8')),
      );
      this.records.clear();
      for (const record of decoded.credentials) {
        this.records.set(record.id, record);
      }
      this.lastMtimeMs = stat.mtimeMs;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        if (!existsSync(this.file)) {
          this.records.clear();
          this.lastMtimeMs = -1;
        }
        return;
      }
      throw error;
    }
  }

  private async persist(): Promise<void> {
    const state = StateSchema.parse({
      version: 1,
      credentials: [...this.records.values()].sort(
        (a, b) =>
          a.scope.localeCompare(b.scope) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      ),
    });
    const temp =
      this.file +
      '.tmp-' +
      process.pid +
      '-' +
      randomBytes(4).toString('hex');
    await fs.writeFile(
      temp,
      JSON.stringify(state, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600 },
    );
    await fs.rename(temp, this.file);
    try {
      await fs.chmod(this.file, 0o600);
    } catch {
      // Windows ACLs are managed by the account/service boundary.
    }
    const stat = await fs.stat(this.file);
    this.lastMtimeMs = stat.mtimeMs;
    this.lastSize = stat.size;
  }
}
