import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

const GroupNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .transform((value) => value.toLowerCase());

const DeviceIdSchema = z.string().min(1).max(128);

const GroupRecordSchema = z.object({
  name: GroupNameSchema,
  deviceIds: z.array(DeviceIdSchema).max(256),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const GroupFileSchema = z.object({
  version: z.literal(1),
  groups: z.array(GroupRecordSchema).max(1024),
});

export type DeviceGroupRecord = z.infer<typeof GroupRecordSchema>;

export class DeviceGroupStore {
  private loaded = false;
  private readonly groups = new Map<string, DeviceGroupRecord>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string) {}

  private get file(): string {
    return path.join(this.rootDir, 'device-groups.json');
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const decoded = GroupFileSchema.parse(
        JSON.parse(await fs.readFile(this.file, 'utf8')),
      );
      for (const group of decoded.groups) {
        this.groups.set(group.name, group);
      }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      this.loaded = false;
      throw error;
    }
  }

  async list(): Promise<DeviceGroupRecord[]> {
    await this.initialize();
    return [...this.groups.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async get(nameInput: string): Promise<DeviceGroupRecord | undefined> {
    await this.initialize();
    let name: string;
    try {
      name = GroupNameSchema.parse(nameInput);
    } catch {
      return undefined;
    }
    return this.groups.get(name);
  }

  async set(
    nameInput: string,
    deviceIdsInput: readonly string[],
  ): Promise<DeviceGroupRecord> {
    await this.initialize();
    const name = GroupNameSchema.parse(nameInput);
    const deviceIds = [...new Set(deviceIdsInput.map((id) => DeviceIdSchema.parse(id)))]
      .sort();
    if (deviceIds.length === 0) {
      throw new Error('Device groups require at least one device ID.');
    }
    if (deviceIds.length > 256) {
      throw new Error('Device groups are limited to 256 device IDs.');
    }

    const now = new Date().toISOString();
    const existing = this.groups.get(name);
    const record = GroupRecordSchema.parse({
      name,
      deviceIds,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.groups.set(name, record);
    await this.persist();
    return record;
  }

  async delete(nameInput: string): Promise<{ name: string; deleted: boolean }> {
    await this.initialize();
    const name = GroupNameSchema.parse(nameInput);
    const deleted = this.groups.delete(name);
    if (deleted) await this.persist();
    return { name, deleted };
  }

  private async persist(): Promise<void> {
    const payload = GroupFileSchema.parse({
      version: 1,
      groups: [...this.groups.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    });

    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await fs.mkdir(this.rootDir, { recursive: true });
      const temp = this.file + '.tmp';
      await fs.writeFile(temp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      await fs.rename(temp, this.file);
    });
    await this.writeChain;
  }
}
