import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

const StepStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'unknown',
]);

const RunbookStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'blocked',
  'interrupted',
]);

const StepSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['task_graph', 'assertions']),
  status: StepStatusSchema,
  dependsOn: z.array(z.string().min(1).max(128)).max(31),
  attempts: z.number().int().min(0),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  blockedBy: z.array(z.string().min(1).max(128)).optional(),
  durationMs: z.number().int().min(0).optional(),
  taskGraphId: z.string().min(1).max(256).optional(),
  errorCode: z.string().min(1).max(128).optional(),
});

const RunbookSchema = z.object({
  id: z.string().min(1).max(128),
  specHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: RunbookStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  runCount: z.number().int().min(1),
  steps: z.array(StepSchema).min(1).max(64),
});

const StateSchema = z.object({
  version: z.literal(1),
  runbooks: z.array(RunbookSchema).max(1000),
});

export type RunbookStepStatus = z.infer<typeof StepStatusSchema>;
export type RunbookStatus = z.infer<typeof RunbookStatusSchema>;

export interface RunbookCheckpointStep {
  id: string;
  kind: 'task_graph' | 'assertions';
  status: RunbookStepStatus;
  dependsOn: string[];
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  blockedBy?: string[];
  durationMs?: number;
  taskGraphId?: string;
  errorCode?: string;
}

export interface RunbookCheckpoint {
  id: string;
  specHash: string;
  status: RunbookStatus;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  steps: RunbookCheckpointStep[];
}

export class RunbookStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RunbookStoreError';
  }
}

function clone(checkpoint: RunbookCheckpoint): RunbookCheckpoint {
  return {
    ...checkpoint,
    steps: checkpoint.steps.map((step) => ({
      ...step,
      dependsOn: [...step.dependsOn],
      ...(step.blockedBy
        ? { blockedBy: [...step.blockedBy] }
        : {}),
    })),
  };
}

export class RunbookStore {
  private readonly runbooks = new Map<string, RunbookCheckpoint>();
  private readonly stateFile: string;
  private readonly retentionMs: number;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: {
    stateFile: string;
    retentionMs?: number;
  }) {
    this.stateFile = options.stateFile;
    this.retentionMs =
      options.retentionMs ?? 14 * 24 * 60 * 60 * 1000;
  }

  async initialize(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.stateFile, 'utf8');
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

    const state = StateSchema.parse(JSON.parse(raw));
    let changed = false;

    for (const persisted of state.runbooks) {
      const checkpoint = clone(persisted);
      if (checkpoint.status === 'running') {
        checkpoint.status = 'interrupted';
        checkpoint.updatedAt = new Date().toISOString();
        for (const step of checkpoint.steps) {
          if (step.status !== 'running') continue;
          step.status = 'unknown';
          delete step.completedAt;
          delete step.durationMs;
          delete step.errorCode;
        }
        changed = true;
      }
      this.runbooks.set(checkpoint.id, checkpoint);
    }

    this.pruneExpiredInMemory();
    if (changed) await this.persist();
  }

  async prepare(input: {
    id: string;
    specHash: string;
    steps: Array<{
      id: string;
      kind: 'task_graph' | 'assertions';
      dependsOn: string[];
      taskGraphId?: string;
    }>;
    resume: boolean;
    retryFailed: boolean;
    retryUnknown: boolean;
  }): Promise<RunbookCheckpoint> {
    const existing = this.runbooks.get(input.id);
    const now = new Date().toISOString();

    if (!existing) {
      const checkpoint: RunbookCheckpoint = {
        id: input.id,
        specHash: input.specHash,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        runCount: 1,
        steps: input.steps.map((step) => ({
          id: step.id,
          kind: step.kind,
          status: 'pending',
          dependsOn: [...step.dependsOn],
          attempts: 0,
          ...(step.taskGraphId
            ? { taskGraphId: step.taskGraphId }
            : {}),
        })),
      };
      this.runbooks.set(checkpoint.id, checkpoint);
      await this.persist();
      return clone(checkpoint);
    }

    if (!input.resume) {
      throw new RunbookStoreError(
        'RUNBOOK_EXISTS',
        'A persisted runbook with this runbook_id already exists. Use resume=true or choose another runbook_id.',
        { runbookId: input.id },
      );
    }
    if (existing.specHash !== input.specHash) {
      throw new RunbookStoreError(
        'RUNBOOK_SPEC_MISMATCH',
        'Submitted runbook does not match the persisted specification.',
        {
          runbookId: input.id,
          expectedSpecHash: existing.specHash,
          submittedSpecHash: input.specHash,
        },
      );
    }

    const submittedIds = input.steps.map((step) => step.id);
    const existingIds = existing.steps.map((step) => step.id);
    if (
      submittedIds.length !== existingIds.length ||
      submittedIds.some((id, index) => id !== existingIds[index])
    ) {
      throw new RunbookStoreError(
        'RUNBOOK_SPEC_MISMATCH',
        'Submitted runbook step order does not match persisted state.',
        { runbookId: input.id },
      );
    }

    existing.status = 'running';
    existing.updatedAt = now;
    existing.runCount++;

    for (const step of existing.steps) {
      if (step.status === 'running') step.status = 'unknown';
    }

    const retrying = new Set(
      existing.steps
        .filter(
          (step) =>
            (step.status === 'unknown' &&
              (step.kind === 'assertions' ||
                input.retryUnknown)) ||
            (step.status === 'failed' && input.retryFailed),
        )
        .map((step) => step.id),
    );

    const reset = (step: RunbookCheckpointStep): void => {
      step.status = 'pending';
      delete step.startedAt;
      delete step.completedAt;
      delete step.blockedBy;
      delete step.durationMs;
      delete step.errorCode;
    };

    for (const step of existing.steps) {
      if (retrying.has(step.id)) {
        reset(step);
        continue;
      }

      if (
        step.status === 'blocked' &&
        (retrying.size > 0 ||
          input.retryFailed ||
          input.retryUnknown)
      ) {
        reset(step);
      }
    }

    await this.persist();
    return clone(existing);
  }

  async save(checkpoint: RunbookCheckpoint): Promise<void> {
    const parsed = RunbookSchema.parse({
      ...checkpoint,
      updatedAt: new Date().toISOString(),
    });
    this.runbooks.set(parsed.id, clone(parsed));
    await this.persist();
  }

  get(id: string): RunbookCheckpoint {
    const checkpoint = this.runbooks.get(id);
    if (!checkpoint) {
      throw new RunbookStoreError(
        'RUNBOOK_NOT_FOUND',
        'Unknown persisted runbook: ' + id,
        { runbookId: id },
      );
    }
    return clone(checkpoint);
  }

  list(): RunbookCheckpoint[] {
    this.pruneExpiredInMemory();
    return [...this.runbooks.values()]
      .map(clone)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async prune(input: { olderThanMs?: number } = {}) {
    const cutoff =
      Date.now() - (input.olderThanMs ?? this.retentionMs);
    let removed = 0;

    for (const [id, runbook] of this.runbooks) {
      if (runbook.status === 'running') continue;
      if (Date.parse(runbook.updatedAt) <= cutoff) {
        this.runbooks.delete(id);
        removed++;
      }
    }

    await this.persist();
    return { removed, remaining: this.runbooks.size };
  }

  private pruneExpiredInMemory(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, runbook] of this.runbooks) {
      if (runbook.status === 'running') continue;
      if (Date.parse(runbook.updatedAt) <= cutoff) {
        this.runbooks.delete(id);
      }
    }
  }

  private async persist(): Promise<void> {
    const snapshot = {
      version: 1 as const,
      runbooks: [...this.runbooks.values()].map(clone),
    };

    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(
          path.dirname(this.stateFile),
          { recursive: true },
        );
        const temp = this.stateFile + '.tmp';
        await fs.writeFile(
          temp,
          JSON.stringify(snapshot, null, 2) + '\n',
          'utf8',
        );
        await fs.rename(temp, this.stateFile);
      });

    await this.persistChain;
  }
}
