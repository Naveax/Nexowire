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
