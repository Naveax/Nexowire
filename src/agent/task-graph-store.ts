import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

const JobStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'unknown',
]);

const GraphStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'blocked',
  'interrupted',
]);

const PersistedJobSchema = z.object({
  id: z.string().min(1).max(128),
  status: JobStatusSchema,
  dependsOn: z.array(z.string().min(1).max(128)).max(31),
  attempts: z.number().int().min(0),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  exitCode: z.number().int().nullable().optional(),
  timedOut: z.boolean().optional(),
  blockedBy: z.array(z.string().min(1).max(128)).optional(),
  artifactIds: z.array(z.string().uuid()).max(32).optional(),
});

const PersistedGraphSchema = z.object({
  id: z.string().min(1).max(128),
  specHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: GraphStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  runCount: z.number().int().min(1),
  jobs: z.array(PersistedJobSchema).min(1).max(32),
});

const PersistedStateSchema = z.object({
  version: z.literal(1),
  graphs: z.array(PersistedGraphSchema).max(1000),
});

export type PersistedTaskJobStatus = z.infer<typeof JobStatusSchema>;
export type PersistedTaskGraphStatus = z.infer<typeof GraphStatusSchema>;

export interface TaskGraphCheckpointJob {
  id: string;
  status: PersistedTaskJobStatus;
  dependsOn: string[];
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  blockedBy?: string[];
  artifactIds?: string[];
}

export interface TaskGraphCheckpoint {
  id: string;
  specHash: string;
  status: PersistedTaskGraphStatus;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  jobs: TaskGraphCheckpointJob[];
}

export class TaskGraphStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TaskGraphStoreError';
  }
}

export interface TaskGraphStoreOptions {
  stateFile: string;
  retentionMs?: number;
}

function cloneGraph(graph: TaskGraphCheckpoint): TaskGraphCheckpoint {
  return {
    ...graph,
    jobs: graph.jobs.map((job) => ({
      ...job,
      dependsOn: [...job.dependsOn],
      ...(job.blockedBy ? { blockedBy: [...job.blockedBy] } : {}),
      ...(job.artifactIds ? { artifactIds: [...job.artifactIds] } : {}),
    })),
  };
}

export class TaskGraphStore {
  private readonly graphs = new Map<string, TaskGraphCheckpoint>();
  private readonly stateFile: string;
  private readonly retentionMs: number;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: TaskGraphStoreOptions) {
    this.stateFile = options.stateFile;
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
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

    const parsed = PersistedStateSchema.parse(JSON.parse(raw));
    let changed = false;
    for (const graph of parsed.graphs) {
      const checkpoint: TaskGraphCheckpoint = cloneGraph(graph);
      if (checkpoint.status === 'running') {
        checkpoint.status = 'interrupted';
        checkpoint.updatedAt = new Date().toISOString();
        for (const job of checkpoint.jobs) {
          if (job.status === 'running') {
            job.status = 'unknown';
            delete job.completedAt;
            delete job.exitCode;
            delete job.timedOut;
            delete job.blockedBy;
        delete job.artifactIds;
          }
        }
        changed = true;
      }
      this.graphs.set(checkpoint.id, checkpoint);
    }

    this.pruneExpiredInMemory();
    if (changed) await this.persistState();
  }

  async prepare(
    input: {
      id: string;
      specHash: string;
      jobs: Array<{ id: string; dependsOn: string[] }>;
      resume: boolean;
      retryFailed: boolean;
      retryUnknown: boolean;
    },
  ): Promise<TaskGraphCheckpoint> {
    const existing = this.graphs.get(input.id);
    const now = new Date().toISOString();

    if (!existing) {
      const graph: TaskGraphCheckpoint = {
        id: input.id,
        specHash: input.specHash,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        runCount: 1,
        jobs: input.jobs.map((job) => ({
          id: job.id,
          status: 'pending',
          dependsOn: [...job.dependsOn],
          attempts: 0,
        })),
      };
      this.graphs.set(graph.id, graph);
      await this.persistState();
      return cloneGraph(graph);
    }

    if (!input.resume) {
      throw new TaskGraphStoreError(
        'TASK_GRAPH_EXISTS',
        'A persisted task graph with this graph_id already exists. Use resume=true or choose another graph_id.',
        { graphId: input.id },
      );
    }

    if (existing.specHash !== input.specHash) {
      throw new TaskGraphStoreError(
        'TASK_GRAPH_SPEC_MISMATCH',
        'The submitted task graph does not match the persisted graph specification.',
        {
          graphId: input.id,
          expectedSpecHash: existing.specHash,
          submittedSpecHash: input.specHash,
        },
      );
    }

    const expectedIds = input.jobs.map((job) => job.id);
    const storedIds = existing.jobs.map((job) => job.id);
    if (
      expectedIds.length !== storedIds.length ||
      expectedIds.some((id, index) => id !== storedIds[index])
    ) {
      throw new TaskGraphStoreError(
        'TASK_GRAPH_SPEC_MISMATCH',
        'The submitted task graph job order does not match the persisted graph.',
        { graphId: input.id },
      );
    }

    existing.status = 'running';
    existing.updatedAt = now;
    existing.runCount++;

    for (const job of existing.jobs) {
      if (job.status === 'running') job.status = 'unknown';
      if (
        (input.retryFailed &&
          (job.status === 'failed' || job.status === 'blocked')) ||
        (input.retryUnknown && job.status === 'unknown')
      ) {
        job.status = 'pending';
        delete job.startedAt;
        delete job.completedAt;
        delete job.exitCode;
        delete job.timedOut;
        delete job.blockedBy;
      }
    }

    await this.persistState();
    return cloneGraph(existing);
  }

  async save(graph: TaskGraphCheckpoint): Promise<void> {
    const parsed = PersistedGraphSchema.parse({
      ...graph,
      updatedAt: new Date().toISOString(),
    });
    this.graphs.set(parsed.id, cloneGraph(parsed));
    await this.persistState();
  }

  get(id: string): TaskGraphCheckpoint {
    const graph = this.graphs.get(id);
    if (!graph) {
      throw new TaskGraphStoreError(
        'TASK_GRAPH_NOT_FOUND',
        'Unknown persisted task graph: ' + id,
        { graphId: id },
      );
    }
    return cloneGraph(graph);
  }

  list(): TaskGraphCheckpoint[] {
    this.pruneExpiredInMemory();
    return [...this.graphs.values()]
      .map(cloneGraph)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async prune(input: { olderThanMs?: number } = {}) {
    const cutoff =
      Date.now() - (input.olderThanMs ?? this.retentionMs);
    let removed = 0;

    for (const [id, graph] of this.graphs) {
      if (graph.status === 'running') continue;
      if (Date.parse(graph.updatedAt) <= cutoff) {
        this.graphs.delete(id);
        removed++;
      }
    }

    await this.persistState();
    return { removed, remaining: this.graphs.size };
  }

  private pruneExpiredInMemory(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, graph] of this.graphs) {
      if (graph.status === 'running') continue;
      if (Date.parse(graph.updatedAt) <= cutoff) this.graphs.delete(id);
    }
  }

  private async persistState(): Promise<void> {
    const snapshot = {
      version: 1 as const,
      graphs: [...this.graphs.values()].map(cloneGraph),
    };

    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
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
