import * as z from 'zod';

const AccountIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{32}$/i);

const RepositorySlugSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

export interface WranglerAccount {
  id: string;
  name: string;
}

export function normalizeCloudflareAccountId(
  input: string,
): string {
  return AccountIdSchema.parse(input);
}

export function normalizeGitHubRepositorySlug(
  input: string,
): string {
  return RepositorySlugSchema.parse(input);
}

export function parseWranglerWhoamiAccount(
  raw: string,
  explicitAccountId?: string,
): WranglerAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('WRANGLER_WHOAMI_INVALID_JSON');
  }
  const root = z
    .object({
      loggedIn: z.boolean(),
      accounts: z.array(
        z.object({
          id: AccountIdSchema,
          name: z.string().min(1),
        }),
      ),
    })
    .parse(parsed);

  if (!root.loggedIn) {
    throw new Error('WRANGLER_NOT_LOGGED_IN');
  }

  if (explicitAccountId) {
    const wanted =
      normalizeCloudflareAccountId(explicitAccountId);
    const found = root.accounts.find(
      (account) => account.id === wanted,
    );
    if (!found) {
      throw new Error(
        'CLOUDFLARE_ACCOUNT_NOT_AVAILABLE:' + wanted,
      );
    }
    return found;
  }

  if (root.accounts.length !== 1) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_AMBIGUOUS:' +
        String(root.accounts.length),
    );
  }

  return root.accounts[0]!;
}

export function parseD1DatabaseId(
  raw: string,
  databaseName = 'nexowire-control-plane',
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('WRANGLER_D1_LIST_INVALID_JSON');
  }

  const rows = z
    .array(
      z
        .object({
          name: z.string(),
          uuid: z.string().optional(),
          id: z.string().optional(),
        })
        .passthrough(),
    )
    .parse(parsed);

  const row = rows.find(
    (entry) => entry.name === databaseName,
  );
  if (!row) {
    throw new Error(
      'CLOUDFLARE_D1_NOT_FOUND:' + databaseName,
    );
  }

  const id = (row.uuid ?? row.id ?? '').trim();
  if (!/^[0-9a-f-]{32,36}$/i.test(id)) {
    throw new Error(
      'CLOUDFLARE_D1_ID_INVALID:' + databaseName,
    );
  }
  return id;
}
export const REQUIRED_GITHUB_DEPLOYMENT_SECRET_NAMES = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'NEXOWIRE_SESSION_SECRET',
  'NEXOWIRE_INTERNAL_SERVICE_TOKEN',
  'NEXOWIRE_CONFIG_ENCRYPTION_KEY',
] as const;

export interface OwnerDeploymentSecretSpec {
  githubName:
    | 'NEXOWIRE_SESSION_SECRET'
    | 'NEXOWIRE_INTERNAL_SERVICE_TOKEN'
    | 'NEXOWIRE_CONFIG_ENCRYPTION_KEY';
  fileName: string;
  purpose: string;
  label: string;
}

export const OWNER_DEPLOYMENT_SECRET_SPECS: readonly OwnerDeploymentSecretSpec[] = [
  {
    githubName: 'NEXOWIRE_SESSION_SECRET',
    fileName: 'session-secret.dpapi.json',
    purpose: 'control-plane-session-secret',
    label: 'control-plane session secret',
  },
  {
    githubName: 'NEXOWIRE_INTERNAL_SERVICE_TOKEN',
    fileName: 'service-token.dpapi.json',
    purpose: 'control-plane-service-token',
    label: 'control-plane service token',
  },
  {
    githubName: 'NEXOWIRE_CONFIG_ENCRYPTION_KEY',
    fileName: 'config-encryption-key.dpapi.json',
    purpose: 'control-plane-config-encryption-key',
    label: 'control-plane config encryption key',
  },
];
