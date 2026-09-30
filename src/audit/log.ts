import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type AuditStatus = 'started' | 'succeeded' | 'failed';

export interface AuditEvent {
  id: string;
  operationId: string;
  at: string;
  status: AuditStatus;
  capability: string;
  targetId?: string;
  providerId?: string;
  durationMs?: number;
  errorCode?: string;
  message?: string;
}


export interface AuditQuery {
  limit?: number;
  capability?: string;
  status?: AuditStatus;
  targetId?: string;
  providerId?: string;
  operationId?: string;
  fromAt?: string;
  toAt?: string;
  maxScanBytes?: number;
}

export interface AuditQueryResult {
  events: AuditEvent[];
  scannedBytes: number;
  fileBytes: number;
  truncatedByScanLimit: boolean;
}

export interface AuditWrite {
  operationId: string;
  status: AuditStatus;
  capability: string;
  targetId?: string;
  providerId?: string;
  durationMs?: number;
  errorCode?: string;
  message?: string;
}

export class AuditLog {
  private readonly recent: AuditEvent[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxRecent = 500,
  ) {}

  async write(input: AuditWrite): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...input,
    };
    this.recent.push(event);
    if (this.recent.length > this.maxRecent) {
      this.recent.splice(0, this.recent.length - this.maxRecent);
    }

    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, JSON.stringify(event) + '\n', 'utf8');
    });
    await this.writeChain;
    return event;
  }

  list(limit = 50): AuditEvent[] {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    return this.recent.slice(-safeLimit).reverse();
  }


  async query(input: AuditQuery = {}): Promise<AuditQueryResult> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const maxScanBytes = Math.max(
      64 * 1024,
      Math.min(input.maxScanBytes ?? 4 * 1024 * 1024, 32 * 1024 * 1024),
    );

    let handle;
    try {
      handle = await fs.open(this.filePath, 'r');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return {
          events: [],
          scannedBytes: 0,
          fileBytes: 0,
          truncatedByScanLimit: false,
        };
      }
      throw error;
    }

    try {
      const stat = await handle.stat();
      const fileBytes = stat.size;
      const start = Math.max(0, fileBytes - maxScanBytes);
      const length = fileBytes - start;
      const buffer = Buffer.alloc(length);
      if (length > 0) {
        await handle.read(buffer, 0, length, start);
      }

      let raw = buffer.toString('utf8');
      if (start > 0) {
        const firstNewline = raw.indexOf('\n');
        raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : '';
      }

      const fromMs =
        input.fromAt === undefined ? undefined : Date.parse(input.fromAt);
      const toMs =
        input.toAt === undefined ? undefined : Date.parse(input.toAt);
      if (fromMs !== undefined && Number.isNaN(fromMs)) {
        throw new Error('Invalid audit fromAt timestamp.');
      }
      if (toMs !== undefined && Number.isNaN(toMs)) {
        throw new Error('Invalid audit toAt timestamp.');
      }

      const events: AuditEvent[] = [];
      const lines = raw.trimEnd().split('\n').filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index--) {
        let event: AuditEvent;
        try {
          event = JSON.parse(lines[index]!) as AuditEvent;
        } catch {
          continue;
        }

        if (input.capability && event.capability !== input.capability) continue;
        if (input.status && event.status !== input.status) continue;
        if (input.targetId && event.targetId !== input.targetId) continue;
        if (input.providerId && event.providerId !== input.providerId) continue;
        if (input.operationId && event.operationId !== input.operationId) continue;

        const atMs = Date.parse(event.at);
        if (fromMs !== undefined && (!Number.isFinite(atMs) || atMs < fromMs)) {
          continue;
        }
        if (toMs !== undefined && (!Number.isFinite(atMs) || atMs > toMs)) {
          continue;
        }

        events.push(event);
        if (events.length >= limit) break;
      }

      return {
        events,
        scannedBytes: length,
        fileBytes,
        truncatedByScanLimit: start > 0,
      };
    } finally {
      await handle.close();
    }
  }

  async loadRecent(limit = 500): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }

    const lines = raw.trimEnd().split('\n').filter(Boolean).slice(-limit);
    this.recent.length = 0;
    for (const line of lines) {
      try {
        this.recent.push(JSON.parse(line) as AuditEvent);
      } catch {
        // Ignore a partial/corrupt tail line instead of losing all audit history.
      }
    }
  }
}
