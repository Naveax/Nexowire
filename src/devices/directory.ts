import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import type { AgentDevice } from '../protocol/agent.js';

const DeviceRecordSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  platform: z.string().min(1).max(64),
  arch: z.string().min(1).max(64),
  agentVersion: z.string().min(1).max(64),
  capabilities: z.array(z.string().min(1).max(128)).max(256),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  lastConnectedAt: z.string().datetime(),
  lastDisconnectedAt: z.string().datetime().optional(),
  connectionCount: z.number().int().min(1),
});

const DeviceFileSchema = z.object({
  version: z.literal(1),
  devices: z.array(DeviceRecordSchema).max(4096),
});

export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

export class DeviceDirectory {
  private loaded = false;
  private readonly records = new Map<string, DeviceRecord>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string) {}

  private get file(): string {
    return path.join(this.rootDir, 'devices.json');
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const decoded = DeviceFileSchema.parse(
        JSON.parse(await fs.readFile(this.file, 'utf8')),
      );
      for (const record of decoded.devices) {
        this.records.set(record.id, record);
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

  async observeConnected(
    device: AgentDevice,
    at = new Date().toISOString(),
  ): Promise<DeviceRecord> {
    await this.initialize();
    const existing = this.records.get(device.id);
    const record = DeviceRecordSchema.parse({
      id: device.id,
      name: device.name,
      platform: device.platform,
      arch: device.arch,
      agentVersion: device.agentVersion,
      capabilities: [...new Set(device.capabilities)].sort(),
      firstSeenAt: existing?.firstSeenAt ?? at,
      lastSeenAt: at,
      lastConnectedAt: at,
      ...(existing?.lastDisconnectedAt
        ? { lastDisconnectedAt: existing.lastDisconnectedAt }
        : {}),
      connectionCount: (existing?.connectionCount ?? 0) + 1,
    });
    this.records.set(record.id, record);
    await this.persist();
    return record;
  }

  async observeDisconnected(
    deviceId: string,
    at = new Date().toISOString(),
  ): Promise<DeviceRecord | undefined> {
    await this.initialize();
    const existing = this.records.get(deviceId);
    if (!existing) return undefined;
    const record = DeviceRecordSchema.parse({
      ...existing,
      lastSeenAt: at,
      lastDisconnectedAt: at,
    });
    this.records.set(deviceId, record);
    await this.persist();
    return record;
  }

  async list(): Promise<DeviceRecord[]> {
    await this.initialize();
    return [...this.records.values()].sort(
      (a, b) =>
        b.lastSeenAt.localeCompare(a.lastSeenAt) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  }

  async get(deviceId: string): Promise<DeviceRecord | undefined> {
    await this.initialize();
    return this.records.get(deviceId);
  }

  private async persist(): Promise<void> {
    const payload = DeviceFileSchema.parse({
      version: 1,
      devices: [...this.records.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    });
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await fs.mkdir(this.rootDir, { recursive: true });
      const temp = this.file + '.tmp';
      await fs.writeFile(
        temp,
        JSON.stringify(payload, null, 2) + '\n',
        'utf8',
      );
      await fs.rename(temp, this.file);
    });
    await this.writeChain;
  }
}
