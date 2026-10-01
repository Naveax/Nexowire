export type SkillMutationLevel = 'read-only' | 'mixed' | 'mutation';
export type SkillPrivilege = 'user' | 'elevated';
export type SkillTrust = 'trusted' | 'reviewed' | 'experimental';
export type SkillPlatform = 'any' | NodeJS.Platform;

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
}

export interface SkillEvaluation {
  runnable: boolean;
  platformCompatible: boolean;
  missingCapabilities: string[];
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const VERSION_RE = /^[0-9]+(?:\.[0-9]+){0,2}(?:[-+][A-Za-z0-9._-]+)?$/;
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
  return [...new Set(
    value
      .split(',')
      .map((entry) => unquote(entry))
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
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

export function parseSkillManifest(
  markdown: string,
  directoryName?: string,
): SkillManifest {
  const values = frontmatter(markdown);

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

  const requires = splitList(values.get('requires'));
  for (const capability of requires) {
    if (
      capability.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(capability)
    ) {
      throw new Error(
        `Invalid required capability in skill manifest: ${capability}`,
      );
    }
  }

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

  return {
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

  return {
    runnable:
      platformCompatible &&
      (capabilitySet === undefined ||
        missingCapabilities.length === 0),
    platformCompatible,
    missingCapabilities,
  };
}
