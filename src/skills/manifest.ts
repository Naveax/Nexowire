export type SkillMutationLevel = 'read-only' | 'mixed' | 'mutation';
export type SkillPrivilege = 'user' | 'elevated';
export type SkillTrust = 'trusted' | 'reviewed' | 'experimental';
export type SkillPlatform = 'any' | NodeJS.Platform;
export type SkillConcurrency = 'serial' | 'parallel-safe';
export type SkillReplay = 'safe' | 'verify' | 'manual';

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  requires: string[];
  platforms: SkillPlatform[];
  mutation: SkillMutationLevel;
  privilege: SkillPrivilege;
  trust: SkillTrust;
  tags: string[];
  manifestVersion?: 2;
  requiresAny?: string[][];
  prefers?: string[];
  concurrency?: SkillConcurrency;
  replay?: SkillReplay;
}

export interface SkillEvaluation {
  runnable: boolean;
  platformCompatible: boolean;
  missingCapabilities: string[];
  unsatisfiedCapabilityGroups?: string[][];
  availablePreferredCapabilities?: string[];
  missingPreferredCapabilities?: string[];
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const VERSION_RE = /^[0-9]+(?:\.[0-9]+){0,2}(?:[-+][A-Za-z0-9._-]+)?$/;
const CAPABILITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ALLOWED_PLATFORMS = new Set<SkillPlatform>([
  'any',
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd',
]);

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((entry) => unquote(entry))
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function validateCapabilities(
  values: readonly string[],
  label: string,
): string[] {
  const result = [...new Set(values)];
  for (const capability of result) {
    if (
      capability.length > 128 ||
      !CAPABILITY_RE.test(capability)
    ) {
      throw new Error(
        `Invalid ${label} capability in skill manifest: ${capability}`,
      );
    }
  }
  return result;
}

function parseAlternativeGroups(
  value: string | undefined,
): string[][] {
  if (!value) return [];

  const groups = value
    .split(';')
    .map((group) =>
      validateCapabilities(
        group
          .split('|')
          .map((entry) => unquote(entry).trim())
          .filter(Boolean),
        'requires_any',
      ),
    )
    .filter((group) => group.length > 0);

  if (groups.length > 16) {
    throw new Error(
      'Skill requires_any exceeds 16 alternative groups.',
    );
  }
  for (const group of groups) {
    if (group.length > 16) {
      throw new Error(
        'Skill requires_any group exceeds 16 alternatives.',
      );
    }
  }

  const seen = new Set<string>();
  return groups.filter((group) => {
    const key = [...group].sort().join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function frontmatter(markdown: string): Map<string, string> {
  const normalized = markdown.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return new Map();

  const values = new Map<string, string>();
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (line.trim() === '---') return values;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const separator = line.indexOf(':');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key) values.set(key, value);
  }

  throw new Error('Skill frontmatter is not terminated with ---');
}

function requiredEnum<T extends string>(
  raw: string | undefined,
  fallback: T,
  allowed: readonly T[],
  field: string,
): T {
  const value = (raw ? unquote(raw) : fallback) as T;
  if (!allowed.includes(value)) {
    throw new Error(
      `Invalid skill ${field}: ${String(value)}. Expected one of ${allowed.join(', ')}.`,
    );
  }
  return value;
}

function manifestVersion(
  raw: string | undefined,
): 1 | 2 {
  const value = unquote(raw ?? '1');
  if (value === '1') return 1;
  if (value === '2') return 2;
  throw new Error(
    `Unsupported skill manifest_version: ${value}. Expected 1 or 2.`,
  );
}

export function parseSkillManifest(
  markdown: string,
  directoryName?: string,
): SkillManifest {
  const values = frontmatter(markdown);
  const format = manifestVersion(values.get('manifest_version'));

  const name = unquote(values.get('name') ?? directoryName ?? '');
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error('Invalid or missing skill name.');
  }

  const description = unquote(
    values.get('description') ??
      'No skill description has been provided.',
  );
  if (!description) {
    throw new Error('Skill description must not be empty.');
  }
  if (description.length > 1000) {
    throw new Error('Skill description exceeds 1000 characters.');
  }

  const version = unquote(values.get('version') ?? '0.1');
  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid skill version: ${version}`);
  }

  const requires = validateCapabilities(
    splitList(values.get('requires')),
    'required',
  );

  const platformsRaw = splitList(values.get('platforms'));
  const platforms: SkillPlatform[] =
    platformsRaw.length === 0
      ? ['any']
      : platformsRaw.map((platform) => {
          if (!ALLOWED_PLATFORMS.has(platform as SkillPlatform)) {
            throw new Error(
              `Invalid skill platform: ${platform}`,
            );
          }
          return platform as SkillPlatform;
        });

  const mutation = requiredEnum(
    values.get('mutation'),
    'mixed',
    ['read-only', 'mixed', 'mutation'] as const,
    'mutation',
  );
  const privilege = requiredEnum(
    values.get('privilege'),
    'user',
    ['user', 'elevated'] as const,
    'privilege',
  );
  const trust = requiredEnum(
    values.get('trust'),
    'reviewed',
    ['trusted', 'reviewed', 'experimental'] as const,
    'trust',
  );

  const tags = splitList(values.get('tags'));
  for (const tag of tags) {
    if (
      tag.length > 64 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag)
    ) {
      throw new Error(`Invalid skill tag: ${tag}`);
    }
  }

  const v2Fields = [
    'requires_any',
    'prefers',
    'concurrency',
    'replay',
  ];
  if (
    format === 1 &&
    v2Fields.some((field) => values.has(field))
  ) {
    throw new Error(
      'Skill manifest v2 fields require manifest_version: 2.',
    );
  }

  const base: SkillManifest = {
    name,
    description,
    version,
    requires,
    platforms: [...new Set(platforms)],
    mutation,
    privilege,
    trust,
    tags,
  };

  if (format === 1) return base;

  const requiresAny = parseAlternativeGroups(
    values.get('requires_any'),
  );
  const prefers = validateCapabilities(
    splitList(values.get('prefers')),
    'preferred',
  );
  const concurrency = requiredEnum(
    values.get('concurrency'),
    'serial',
    ['serial', 'parallel-safe'] as const,
    'concurrency',
  );
  const replay = requiredEnum(
    values.get('replay'),
    mutation === 'read-only' ? 'safe' : 'verify',
    ['safe', 'verify', 'manual'] as const,
    'replay',
  );

  if (mutation !== 'read-only' && replay === 'safe') {
    throw new Error(
      'Mutation or mixed skills cannot declare replay: safe.',
    );
  }

  return {
    ...base,
    manifestVersion: 2,
    ...(requiresAny.length > 0 ? { requiresAny } : {}),
    ...(prefers.length > 0 ? { prefers } : {}),
    concurrency,
    replay,
  };
}

export function evaluateSkillManifest(
  manifest: SkillManifest,
  options: {
    capabilities?: readonly string[];
    platform?: NodeJS.Platform;
  } = {},
): SkillEvaluation {
  const capabilitySet = options.capabilities
    ? new Set(options.capabilities)
    : undefined;
  const missingCapabilities = capabilitySet
    ? manifest.requires.filter(
        (capability) => !capabilitySet.has(capability),
      )
    : [];

  const platformCompatible =
    options.platform === undefined ||
    manifest.platforms.includes('any') ||
    manifest.platforms.includes(options.platform);

  const base: SkillEvaluation = {
    runnable:
      platformCompatible &&
      (capabilitySet === undefined ||
        missingCapabilities.length === 0),
    platformCompatible,
    missingCapabilities,
  };

  if (manifest.manifestVersion !== 2) {
    return base;
  }

  const unsatisfiedCapabilityGroups = capabilitySet
    ? (manifest.requiresAny ?? []).filter(
        (group) =>
          !group.some((capability) =>
            capabilitySet.has(capability),
          ),
      )
    : [];

  const availablePreferredCapabilities = capabilitySet
    ? (manifest.prefers ?? []).filter((capability) =>
        capabilitySet.has(capability),
      )
    : [];
  const missingPreferredCapabilities = capabilitySet
    ? (manifest.prefers ?? []).filter(
        (capability) => !capabilitySet.has(capability),
      )
    : [];

  return {
    ...base,
    runnable:
      base.runnable &&
      (capabilitySet === undefined ||
        unsatisfiedCapabilityGroups.length === 0),
    unsatisfiedCapabilityGroups,
    availablePreferredCapabilities,
    missingPreferredCapabilities,
  };
}
