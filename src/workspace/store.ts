import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

const WorkspaceStatusSchema = z.enum([
  'active',
  'blocked',
  'completed',
  'abandoned',
]);

const WorkspaceArtifactRefSchema = z.object({
  graphId: z.string().min(1).max(128),
  jobId: z.string().min(1).max(128).optional(),
  requestedPath: z.string().min(1).max(4096).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const WorkspaceCheckpointSchema = z.object({
  deviceId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(256),
  revision: z.number().int().min(1).default(1),
  status: WorkspaceStatusSchema.default('active'),
  cwd: z.string().max(4096).optional(),
  summary: z.string().max(20_000),
  completed: z.array(z.string().max(4096)).max(200).default([]),
  remaining: z.array(z.string().max(4096)).max(200).default([]),
  blockers: z.array(z.string().max(4096)).max(100).default([]),
  lastCommands: z.array(z.string().max(8192)).max(100).default([]),
  taskGraphIds: z.array(z.string().min(1).max(128)).max(100).default([]),
  processSessionIds: z
    .array(z.string().min(1).max(128))
    .max(100)
    .default([]),
  artifactRefs: z.array(WorkspaceArtifactRefSchema).max(200).default([]),
  updatedAt: z.string().datetime(),
});

export type WorkspaceCheckpoint = z.infer<
  typeof WorkspaceCheckpointSchema
>;

export interface WorkspaceCheckpointSaveInput {
  deviceId: string;
  workspaceId: string;
  expectedRevision?: number;
  status?: z.infer<typeof WorkspaceStatusSchema>;
  cwd?: string;
  summary: string;
  completed?: string[];
  remaining?: string[];
  blockers?: string[];
  lastCommands?: string[];
  taskGraphIds?: string[];
  processSessionIds?: string[];
  artifactRefs?: Array<
    z.input<typeof WorkspaceArtifactRefSchema>
  >;
}

export class WorkspaceCheckpointConflictError extends Error {
  readonly code = 'WORKSPACE_CHECKPOINT_CONFLICT';

  constructor(
    message: string,
    readonly details: {
      deviceId: string;
      workspaceId: string;
      expectedRevision: number;
      actualRevision: number;
    },
  ) {
    super(message);
    this.name = 'WorkspaceCheckpointConflictError';
  }
}

function keyFor(deviceId: string, workspaceId: string): string {
  return createHash('sha256')
    .update(deviceId)
    .update('\u0000')
    .update(workspaceId)
    .digest('hex');
}

export class WorkspaceStore {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string) {}

  async save(
    input: WorkspaceCheckpointSaveInput,
  ): Promise<WorkspaceCheckpoint> {
    const operation = this.writeTail.then(
      async () => await this.saveInternal(input),
    );
    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  async get(
    deviceId: string,
    workspaceId: string,
  ): Promise<WorkspaceCheckpoint | null> {
    const file = this.fileFor(deviceId, workspaceId);
    try {
      return WorkspaceCheckpointSchema.parse(
        JSON.parse(await fs.readFile(file, 'utf8')),
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null;
      }
      throw error;
    }
  }

  async list(): Promise<WorkspaceCheckpoint[]> {
    try {
      const names = await fs.readdir(this.rootDir);
      const checkpoints: WorkspaceCheckpoint[] = [];
      for (const name of names.filter((value) =>
        value.startsWith('workspace-'),
      )) {
        const raw = await fs.readFile(
          path.join(this.rootDir, name),
          'utf8',
        );
        checkpoints.push(
          WorkspaceCheckpointSchema.parse(JSON.parse(raw)),
        );
      }
      return checkpoints.sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
  }

  private async saveInternal(
    input: WorkspaceCheckpointSaveInput,
  ): Promise<WorkspaceCheckpoint> {
    const existing = await this.get(
      input.deviceId,
      input.workspaceId,
    );
    const actualRevision = existing?.revision ?? 0;

    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== actualRevision
    ) {
      throw new WorkspaceCheckpointConflictError(
        'Workspace checkpoint revision changed before save.',
        {
          deviceId: input.deviceId,
          workspaceId: input.workspaceId,
          expectedRevision: input.expectedRevision,
          actualRevision,
        },
      );
    }

    const checkpoint = WorkspaceCheckpointSchema.parse({
      deviceId: input.deviceId,
      workspaceId: input.workspaceId,
      revision: actualRevision + 1,
      status: input.status ?? existing?.status ?? 'active',
      ...(input.cwd !== undefined
        ? { cwd: input.cwd }
        : existing?.cwd
          ? { cwd: existing.cwd }
          : {}),
      summary: input.summary,
      completed: input.completed ?? existing?.completed ?? [],
      remaining: input.remaining ?? existing?.remaining ?? [],
      blockers: input.blockers ?? existing?.blockers ?? [],
      lastCommands:
        input.lastCommands ?? existing?.lastCommands ?? [],
      taskGraphIds:
        input.taskGraphIds ?? existing?.taskGraphIds ?? [],
      processSessionIds:
        input.processSessionIds ??
        existing?.processSessionIds ??
        [],
      artifactRefs:
        input.artifactRefs ?? existing?.artifactRefs ?? [],
      updatedAt: new Date().toISOString(),
    });

    await fs.mkdir(this.rootDir, { recursive: true });
    const file = this.fileFor(
      checkpoint.deviceId,
      checkpoint.workspaceId,
    );
    const temp =
      file +
      '.tmp-' +
      process.pid +
      '-' +
      Math.random().toString(16).slice(2);
    await fs.writeFile(
      temp,
      JSON.stringify(checkpoint, null, 2) + '\n',
      'utf8',
    );
    await fs.rename(temp, file);
    return checkpoint;
  }

  private fileFor(
    deviceId: string,
    workspaceId: string,
  ): string {
    return path.join(
      this.rootDir,
      `workspace-${keyFor(deviceId, workspaceId)}.json`,
    );
  }
}
