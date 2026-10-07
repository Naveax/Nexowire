import { createHash } from 'node:crypto';

export class AgentRequestCacheError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentRequestCacheError';
  }
}

interface CacheEntry<T> {
  fingerprint: string;
  promise: Promise<T>;
  createdAt: number;
  expiresAt: number;
  settled: boolean;
}

export interface AgentRequestCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export function fingerprintAgentRequest(
  capability: string,
  input: unknown,
  accessMode: 'safe' | 'full' = 'safe',
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        capability,
        input,
        accessMode,
      }),
      'utf8',
    )
    .digest('hex');
}

export class AgentRequestCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: AgentRequestCacheOptions = {}) {
    this.ttlMs = Math.min(
      30 * 60_000,
      Math.max(5_000, options.ttlMs ?? 5 * 60_000),
    );
    this.maxEntries = Math.min(
      10_000,
      Math.max(16, options.maxEntries ?? 1_024),
    );
    this.now = options.now ?? Date.now;
  }

  size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  async run(
    requestId: string,
    fingerprint: string,
    execute: () => Promise<T>,
  ): Promise<T> {
    this.pruneExpired();

    const existing = this.entries.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new AgentRequestCacheError(
          'REQUEST_ID_REUSE_MISMATCH',
          'The same agent request ID was reused with different capability/input data.',
          { requestId },
        );
      }
      return await existing.promise;
    }

    this.makeRoom();
    if (this.entries.size >= this.maxEntries) {
      throw new AgentRequestCacheError(
        'REQUEST_CACHE_SATURATED',
        'The native-agent request continuity cache is full of in-flight requests.',
        {
          maxEntries: this.maxEntries,
        },
      );
    }

    const createdAt = this.now();
    const entry: CacheEntry<T> = {
      fingerprint,
      createdAt,
      expiresAt: Number.POSITIVE_INFINITY,
      settled: false,
      promise: Promise.resolve(undefined as T),
    };

    const promise = Promise.resolve()
      .then(execute)
      .then(
        (value) => {
          entry.settled = true;
          entry.expiresAt = this.now() + this.ttlMs;
          return value;
        },
        (error) => {
          this.entries.delete(requestId);
          throw error;
        },
      );

    entry.promise = promise;
    this.entries.set(requestId, entry);
    return await promise;
  }

  private makeRoom(): void {
    if (this.entries.size < this.maxEntries) return;

    const settled = [...this.entries.entries()]
      .filter(([, entry]) => entry.settled)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);

    for (const [requestId] of settled) {
      if (this.entries.size < this.maxEntries) break;
      this.entries.delete(requestId);
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [requestId, entry] of this.entries) {
      if (entry.settled && entry.expiresAt <= now) {
        this.entries.delete(requestId);
      }
    }
  }
}
