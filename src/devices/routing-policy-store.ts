import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

const PolicyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .transform((value) => value.toLowerCase());

const SelectionSchema = z.enum(['unique_only', 'priority']);

const PolicySchema = z.object({
  name: PolicyNameSchema,
  selection: SelectionSchema,
  group: z.string().min(1).max(64).optional(),
  platform: z.string().min(1).max(64).optional(),
  nameContains: z.string().min(1).max(128).optional(),
  requiredCapabilities: z
    .array(z.string().min(1).max(128))
    .max(64),
  priorityDeviceIds: z
    .array(z.string().min(1).max(128))
    .max(256),
  onlineOnly: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const StateSchema = z.object({
  version: z.literal(1),
  policies: z.array(PolicySchema).max(1024),
});

export type DeviceRoutingPolicy = z.infer<typeof PolicySchema>;

export class DeviceRoutingPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DeviceRoutingPolicyError';
  }
}

export class DeviceRoutingPolicyStore {
  private loaded = false;
  private readonly policies = new Map<string, DeviceRoutingPolicy>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string) {}

  private get file(): string {
    return path.join(this.rootDir, 'device-routing-policies.json');
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = StateSchema.parse(
        JSON.parse(await fs.readFile(this.file, 'utf8')),
      );
      for (const policy of parsed.policies) {
        this.policies.set(policy.name, policy);
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

  async list(): Promise<DeviceRoutingPolicy[]> {
    await this.initialize();
    return [...this.policies.values()]
      .map((policy) => ({
        ...policy,
        requiredCapabilities: [...policy.requiredCapabilities],
        priorityDeviceIds: [...policy.priorityDeviceIds],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(
    nameInput: string,
  ): Promise<DeviceRoutingPolicy | undefined> {
    await this.initialize();
    let name: string;
    try {
      name = PolicyNameSchema.parse(nameInput);
    } catch {
      return undefined;
    }
    const policy = this.policies.get(name);
    return policy
      ? {
          ...policy,
          requiredCapabilities: [...policy.requiredCapabilities],
          priorityDeviceIds: [...policy.priorityDeviceIds],
        }
      : undefined;
  }

  async set(
    nameInput: string,
    input: {
      selection?: 'unique_only' | 'priority';
      group?: string;
      platform?: string;
      nameContains?: string;
      requiredCapabilities?: readonly string[];
      priorityDeviceIds?: readonly string[];
      onlineOnly?: boolean;
    },
  ): Promise<DeviceRoutingPolicy> {
    await this.initialize();
    const name = PolicyNameSchema.parse(nameInput);
    const selection = SelectionSchema.parse(
      input.selection ?? 'unique_only',
    );
    const requiredCapabilities = [
      ...new Set(input.requiredCapabilities ?? []),
    ].sort();
    const priorityDeviceIds = [
      ...new Set(input.priorityDeviceIds ?? []),
    ];

    if (
      selection === 'priority' &&
      priorityDeviceIds.length === 0
    ) {
      throw new DeviceRoutingPolicyError(
        'ROUTING_POLICY_PRIORITY_EMPTY',
        'Priority routing requires at least one stable device ID.',
      );
    }

    const now = new Date().toISOString();
    const existing = this.policies.get(name);
    const policy = PolicySchema.parse({
      name,
      selection,
      ...(input.group ? { group: input.group.toLowerCase() } : {}),
      ...(input.platform
        ? { platform: input.platform.toLowerCase() }
        : {}),
      ...(input.nameContains
        ? { nameContains: input.nameContains }
        : {}),
      requiredCapabilities,
      priorityDeviceIds,
      onlineOnly: input.onlineOnly ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    this.policies.set(name, policy);
    await this.persist();
    return {
      ...policy,
      requiredCapabilities: [...policy.requiredCapabilities],
      priorityDeviceIds: [...policy.priorityDeviceIds],
    };
  }

  async delete(
    nameInput: string,
  ): Promise<{ name: string; deleted: boolean }> {
    await this.initialize();
    const name = PolicyNameSchema.parse(nameInput);
    const deleted = this.policies.delete(name);
    if (deleted) await this.persist();
    return { name, deleted };
  }

  private async persist(): Promise<void> {
    const snapshot = StateSchema.parse({
      version: 1,
      policies: [...this.policies.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    });

    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await fs.mkdir(this.rootDir, { recursive: true });
      const temp = this.file + '.tmp';
      await fs.writeFile(
        temp,
        JSON.stringify(snapshot, null, 2) + '\n',
        'utf8',
      );
      await fs.rename(temp, this.file);
    });
    await this.writeChain;
  }
}
