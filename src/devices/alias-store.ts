import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

const AliasSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .transform((value) => value.toLowerCase());

const AliasRecordSchema = z.object({
  alias: AliasSchema,
  deviceId: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const AliasFileSchema = z.object({
  version: z.literal(1),
  aliases: z.array(AliasRecordSchema).max(1024),
});

export type DeviceAliasRecord = z.infer<typeof AliasRecordSchema>;

export class DeviceAliasStore {
  private loaded = false;
  private readonly aliases = new Map<string, DeviceAliasRecord>();

  constructor(private readonly rootDir: string) {}

  private get file(): string {
    return path.join(this.rootDir, 'device-aliases.json');
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const decoded = AliasFileSchema.parse(
        JSON.parse(await fs.readFile(this.file, 'utf8')),
      );
      for (const record of decoded.aliases) {
        this.aliases.set(record.alias, record);
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

  async list(): Promise<DeviceAliasRecord[]> {
    await this.initialize();
    return [...this.aliases.values()].sort(
      (a, b) => a.alias.localeCompare(b.alias),
    );
  }

  async resolve(value: string): Promise<string | undefined> {
    await this.initialize();
    let alias: string;
    try {
      alias = AliasSchema.parse(value);
    } catch {
      return undefined;
    }
    return this.aliases.get(alias)?.deviceId;
  }

  async aliasesForDevice(deviceId: string): Promise<string[]> {
    await this.initialize();
    return [...this.aliases.values()]
      .filter((record) => record.deviceId === deviceId)
      .map((record) => record.alias)
      .sort();
  }

  async set(aliasInput: string, deviceId: string): Promise<DeviceAliasRecord> {
    await this.initialize();
    const alias = AliasSchema.parse(aliasInput);
    const now = new Date().toISOString();
    const existing = this.aliases.get(alias);
    const record = AliasRecordSchema.parse({
      alias,
      deviceId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.aliases.set(alias, record);
    await this.persist();
    return record;
  }

  async delete(aliasInput: string): Promise<{ alias: string; deleted: boolean }> {
    await this.initialize();
    const alias = AliasSchema.parse(aliasInput);
    const deleted = this.aliases.delete(alias);
    if (deleted) await this.persist();
    return { alias, deleted };
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const payload = AliasFileSchema.parse({
      version: 1,
      aliases: [...this.aliases.values()].sort(
        (a, b) => a.alias.localeCompare(b.alias),
      ),
    });
    const temp = this.file + '.tmp';
    await fs.writeFile(temp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await fs.rename(temp, this.file);
  }
}
