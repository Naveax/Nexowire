import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

const ProfileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .transform((value) => value.toLowerCase());

const CapabilityPatternSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^(?:\*|[A-Za-z0-9][A-Za-z0-9._:-]*|[A-Za-z0-9][A-Za-z0-9._:-]*\.\*)$/);

const ProfileSchema = z.object({
  name: ProfileNameSchema,
  allow: z.array(CapabilityPatternSchema).min(1).max(256),
  deny: z.array(CapabilityPatternSchema).max(256),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const BindingSchema = z.object({
  deviceId: z.string().min(1).max(128),
  profile: ProfileNameSchema,
  updatedAt: z.string().datetime(),
});

const StateSchema = z.object({
  version: z.literal(1),
  profiles: z.array(ProfileSchema).max(256),
  bindings: z.array(BindingSchema).max(4096),
});

export type CapabilityPolicyProfile = z.infer<typeof ProfileSchema>;
export type CapabilityPolicyBinding = z.infer<typeof BindingSchema>;

export class CapabilityPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CapabilityPolicyError';
  }
}

function normalizePatterns(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => CapabilityPatternSchema.parse(value)))]
    .sort();
}

function patternMatches(pattern: string, capability: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return capability.startsWith(prefix);
  }
  return pattern === capability;
}

export class CapabilityPolicyStore {
  private loaded = false;
  private readonly profiles = new Map<string, CapabilityPolicyProfile>();
  private readonly bindings = new Map<string, CapabilityPolicyBinding>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string) {}

  private get file(): string {
    return path.join(this.rootDir, 'capability-policies.json');
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = StateSchema.parse(
        JSON.parse(await fs.readFile(this.file, 'utf8')),
      );
      for (const profile of parsed.profiles) {
        this.profiles.set(profile.name, profile);
      }
      for (const binding of parsed.bindings) {
        if (this.profiles.has(binding.profile)) {
          this.bindings.set(binding.deviceId, binding);
        }
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

  async listProfiles(): Promise<CapabilityPolicyProfile[]> {
    await this.initialize();
    return [...this.profiles.values()]
      .map((profile) => ({
        ...profile,
        allow: [...profile.allow],
        deny: [...profile.deny],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listBindings(): Promise<CapabilityPolicyBinding[]> {
    await this.initialize();
    return [...this.bindings.values()]
      .map((binding) => ({ ...binding }))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  async getProfile(
    nameInput: string,
  ): Promise<CapabilityPolicyProfile | undefined> {
    await this.initialize();
    let name: string;
    try {
      name = ProfileNameSchema.parse(nameInput);
    } catch {
      return undefined;
    }
    const profile = this.profiles.get(name);
    return profile
      ? {
          ...profile,
          allow: [...profile.allow],
          deny: [...profile.deny],
        }
      : undefined;
  }

  async setProfile(
    nameInput: string,
    input: {
      allow: readonly string[];
      deny?: readonly string[];
    },
  ): Promise<CapabilityPolicyProfile> {
    await this.initialize();
    const name = ProfileNameSchema.parse(nameInput);
    const allow = normalizePatterns(input.allow);
    if (allow.length === 0) {
      throw new CapabilityPolicyError(
        'POLICY_EMPTY_ALLOWLIST',
        'A policy profile must explicitly allow at least one capability pattern.',
      );
    }
    const deny = normalizePatterns(input.deny ?? []);
    const now = new Date().toISOString();
    const existing = this.profiles.get(name);
    const profile = ProfileSchema.parse({
      name,
      allow,
      deny,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.profiles.set(name, profile);
    await this.persist();
    return {
      ...profile,
      allow: [...profile.allow],
      deny: [...profile.deny],
    };
  }

  async deleteProfile(
    nameInput: string,
  ): Promise<{
    name: string;
    deleted: boolean;
    removedBindings: number;
  }> {
    await this.initialize();
    const name = ProfileNameSchema.parse(nameInput);
    const deleted = this.profiles.delete(name);
    let removedBindings = 0;
    if (deleted) {
      for (const [deviceId, binding] of this.bindings) {
        if (binding.profile !== name) continue;
        this.bindings.delete(deviceId);
        removedBindings++;
      }
      await this.persist();
    }
    return { name, deleted, removedBindings };
  }

  async bind(
    deviceId: string,
    profileInput: string,
  ): Promise<CapabilityPolicyBinding> {
    await this.initialize();
    const profile = ProfileNameSchema.parse(profileInput);
    if (!this.profiles.has(profile)) {
      throw new CapabilityPolicyError(
        'POLICY_PROFILE_NOT_FOUND',
        'Cannot bind an unknown capability policy profile.',
        { profile },
      );
    }
    const binding = BindingSchema.parse({
      deviceId,
      profile,
      updatedAt: new Date().toISOString(),
    });
    this.bindings.set(deviceId, binding);
    await this.persist();
    return { ...binding };
  }

  async unbind(
    deviceId: string,
  ): Promise<{ deviceId: string; removed: boolean }> {
    await this.initialize();
    const removed = this.bindings.delete(deviceId);
    if (removed) await this.persist();
    return { deviceId, removed };
  }

  async decision(
    deviceId: string,
    capability: string,
  ): Promise<{
    allowed: boolean;
    bound: boolean;
    profile?: string;
    matchedAllow?: string;
    matchedDeny?: string;
  }> {
    await this.initialize();
    const binding = this.bindings.get(deviceId);
    if (!binding) {
      return { allowed: true, bound: false };
    }

    const profile = this.profiles.get(binding.profile);
    if (!profile) {
      throw new CapabilityPolicyError(
        'POLICY_PROFILE_NOT_FOUND',
        'A device references a missing capability policy profile.',
        { deviceId, profile: binding.profile },
      );
    }

    const matchedDeny = profile.deny.find((pattern) =>
      patternMatches(pattern, capability),
    );
    const matchedAllow = profile.allow.find((pattern) =>
      patternMatches(pattern, capability),
    );

    return {
      allowed: Boolean(matchedAllow) && !matchedDeny,
      bound: true,
      profile: profile.name,
      ...(matchedAllow ? { matchedAllow } : {}),
      ...(matchedDeny ? { matchedDeny } : {}),
    };
  }

  async assertAllowed(
    deviceId: string,
    capability: string,
  ): Promise<void> {
    const decision = await this.decision(deviceId, capability);
    if (decision.allowed) return;
    throw new CapabilityPolicyError(
      'CAPABILITY_DENIED',
      `Capability "${capability}" is denied by the bound device policy.`,
      {
        deviceId,
        capability,
        profile: decision.profile,
        matchedAllow: decision.matchedAllow,
        matchedDeny: decision.matchedDeny,
      },
    );
  }

  private async persist(): Promise<void> {
    const snapshot = StateSchema.parse({
      version: 1,
      profiles: [...this.profiles.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      bindings: [...this.bindings.values()].sort((a, b) =>
        a.deviceId.localeCompare(b.deviceId),
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
