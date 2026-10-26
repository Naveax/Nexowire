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

const PersistedArtifactSchema = z.object({
  requestedPath: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096),
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  modifiedAt: z.string().datetime(),
});

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
  artifacts: z.array(PersistedArtifactSchema).max(32).optional(),
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

// Load the complete supported admission range across restart. Lowering the
// configured limit must not discard previously recorded UNKNOWN effects.
const MAX_TASK_GRAPH_JOURNAL_ENTRIES = 65_536;
const PersistedStateSchema = z.object({
  version: z.literal(1),
  graphs: z.array(PersistedGraphSchema).max(MAX_TASK_GRAPH_JOURNAL_ENTRIES),
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
  artifacts?: Array<{
    requestedPath: string;
    path: string;
    size: number;
    sha256: string;
    modifiedAt: string;
  }>;
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

export interface TaskArtifactRecord {
  graphId: string;
  graphStatus: PersistedTaskGraphStatus;
  graphUpdatedAt: string;
  jobId: string;
  jobStatus: PersistedTaskJobStatus;
  requestedPath: string;
  path: string;
  size: number;
  sha256: string;
  modifiedAt: string;
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
  maxEntries?: number;
}

function cloneGraph(graph: TaskGraphCheckpoint): TaskGraphCheckpoint {
  return {
    ...graph,
    jobs: graph.jobs.map((job) => ({
      ...job,
      dependsOn: [...job.dependsOn],
      ...(job.blockedBy ? { blockedBy: [...job.blockedBy] } : {}),
      ...(job.artifacts
        ? {
            artifacts: job.artifacts.map((artifact) => ({ ...artifact })),
          }
        : {}),
    })),
  };
}

export class TaskGraphStore {
  private readonly graphs = new Map<string, TaskGraphCheckpoint>();
  private readonly stateFile: string;
  private readonly retentionMs: number;
  private readonly maxEntries: number;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: TaskGraphStoreOptions) {
    this.stateFile = options.stateFile;
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    const maxEntries=options.maxEntries ?? 4096;
    if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>MAX_TASK_GRAPH_JOURNAL_ENTRIES)
      throw new Error('TASK_GRAPH_JOURNAL_CAPACITY_CONFIG_INVALID');
    this.maxEntries=maxEntries;
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
    // Validate all identity keys before state restoration; otherwise a
    // repeated JSON graph ID can overwrite the earlier UNKNOWN in Map.set.
    const seenIds=new Set<string>();
    for(const entry of parsed.graphs){
      if(seenIds.has(entry.id))
        throw new TaskGraphStoreError('TASK_GRAPH_JOURNAL_DUPLICATE_ID',
          'Duplicate durable task-graph identity requires external reconciliation.');
      seenIds.add(entry.id);
    }
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
          }
        }
        changed = true;
      }
      this.graphs.set(checkpoint.id, checkpoint);
    }

    // Local TTL must not erase unreconciled native-effect history on startup.
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
      // Never silently evict unresolved effects at capacity, even when the
      // prior graph appears locally completed. Require external reconciliation.
      if(this.graphs.size>=this.maxEntries)
        throw new TaskGraphStoreError('TASK_GRAPH_JOURNAL_CAPACITY_REACHED',
          'Task graph journal full; independent mutation reconciliation required.');
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
        delete job.artifacts;
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
    // A checkpoint update cannot create an unreserved mutation identity.
    // Reserve it first through prepare(), which enforces journal capacity.
    if(!this.graphs.has(parsed.id))
      throw new TaskGraphStoreError('TASK_GRAPH_NOT_PREPARED',
        'Checkpoint must be admitted through prepare before it can be saved.');
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
    // Enumeration alone must never retire UNKNOWN/native mutation history.
    return [...this.graphs.values()]
      .map(cloneGraph)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listArtifacts(input: {
    graphId?: string;
    jobId?: string;
    limit?: number;
  } = {}): TaskArtifactRecord[] {
    // Artifact reads cannot garbage-collect unrelated mutation checkpoints.
    if (input.graphId && !this.graphs.has(input.graphId)) {
      throw new TaskGraphStoreError(
        'TASK_GRAPH_NOT_FOUND',
        'Unknown persisted task graph: ' + input.graphId,
        { graphId: input.graphId },
      );
    }
    const limit = Math.min(1000, Math.max(1, input.limit ?? 200));
    const records: TaskArtifactRecord[] = [];

    const graphs = [...this.graphs.values()].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    );
    for (const graph of graphs) {
      if (input.graphId && graph.id !== input.graphId) continue;
      for (const job of graph.jobs) {
        if (input.jobId && job.id !== input.jobId) continue;
        for (const artifact of job.artifacts ?? []) {
          records.push({
            graphId: graph.id,
            graphStatus: graph.status,
            graphUpdatedAt: graph.updatedAt,
            jobId: job.id,
            jobStatus: job.status,
            ...artifact,
          });
          if (records.length >= limit) return records;
        }
      }
    }
    return records;
  }

  /** Native mutation history may be pruned only after independent CAS/tombstones. */
  async prune(_input: { olderThanMs?: number } = {}): Promise<never> {
    throw new TaskGraphStoreError(
      'RECONCILE_REQUIRED',
      'Task graph pruning needs off-host mutation tombstones and reconciliation.',
    );
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
