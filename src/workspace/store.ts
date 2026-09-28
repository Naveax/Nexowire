import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

export const WorkspaceCheckpointSchema = z.object({
  deviceId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(256),
  cwd: z.string().max(4096).optional(),
  summary: z.string().max(20_000),
  completed: z.array(z.string().max(4096)).max(200).default([]),
  remaining: z.array(z.string().max(4096)).max(200).default([]),
  lastCommands: z.array(z.string().max(8192)).max(100).default([]),
  updatedAt: z.string().datetime(),
});

export type WorkspaceCheckpoint = z.infer<typeof WorkspaceCheckpointSchema>;

function keyFor(deviceId: string, workspaceId: string): string {
  return createHash('sha256')
    .update(deviceId)
    .update('\u0000')
    .update(workspaceId)
    .digest('hex');
}

export class WorkspaceStore {
  constructor(private readonly rootDir: string) {}

  async save(
    input: Omit<WorkspaceCheckpoint, 'updatedAt'>,
  ): Promise<WorkspaceCheckpoint> {
    const checkpoint = WorkspaceCheckpointSchema.parse({
      ...input,
      updatedAt: new Date().toISOString(),
    });

    await fs.mkdir(this.rootDir, { recursive: true });
    const file = path.join(
      this.rootDir,
      `workspace-${keyFor(checkpoint.deviceId, checkpoint.workspaceId)}.json`,
    );
    const temp = file + '.tmp';
    await fs.writeFile(temp, JSON.stringify(checkpoint, null, 2) + '\n', 'utf8');
    await fs.rename(temp, file);
    return checkpoint;
  }

  async get(
    deviceId: string,
    workspaceId: string,
  ): Promise<WorkspaceCheckpoint | null> {
    const file = path.join(
      this.rootDir,
      `workspace-${keyFor(deviceId, workspaceId)}.json`,
    );
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
      for (const name of names.filter((value) => value.startsWith('workspace-'))) {
        const raw = await fs.readFile(path.join(this.rootDir, name), 'utf8');
        checkpoints.push(WorkspaceCheckpointSchema.parse(JSON.parse(raw)));
      }
      return checkpoints.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
}
