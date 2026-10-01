import type { NexowireConfig } from '../config.js';
import {
  CredentialRoleSchema,
  CredentialScopeSchema,
  CredentialStore,
  type CredentialRole,
  type CredentialScope,
} from './credential-store.js';

function usage(): never {
  throw new Error(
    'Usage: nexowire credentials list [mcp|agent] | issue <mcp|agent> [name] [ttl_seconds] [--allow-tool <pattern>]... [--allow-device <stable-id>]... [--allow-route <policy>]... [--role user|operator|admin] [--admin] | revoke <id>',
  );
}

function parseIssueOptions(
  scope: CredentialScope,
  args: readonly string[],
): {
  name?: string;
  ttlMs?: number;
  allowedTools?: string[];
  allowedDeviceIds?: string[];
  allowedRoutingPolicies?: string[];
  role?: CredentialRole;
  administrative?: boolean;
} {
  const positional: string[] = [];
  const allowedTools: string[] = [];
  const allowedDeviceIds: string[] = [];
  const allowedRoutingPolicies: string[] = [];
  let role: CredentialRole | undefined;
  let administrative = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--allow-tool') {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith('--')) {
        throw new Error('--allow-tool requires a pattern.');
      }
      allowedTools.push(value);
      index++;
      continue;
    }

    if (arg.startsWith('--allow-tool=')) {
      const value = arg.slice('--allow-tool='.length).trim();
      if (!value) {
        throw new Error('--allow-tool requires a pattern.');
      }
      allowedTools.push(value);
      continue;
    }

    if (arg === '--allow-device') {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith('--')) {
        throw new Error('--allow-device requires a stable device ID.');
      }
      allowedDeviceIds.push(value);
      index++;
      continue;
    }

    if (arg.startsWith('--allow-device=')) {
      const value = arg.slice('--allow-device='.length).trim();
      if (!value) {
        throw new Error('--allow-device requires a stable device ID.');
      }
      allowedDeviceIds.push(value);
      continue;
    }

    if (arg === '--allow-route') {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith('--')) {
        throw new Error('--allow-route requires a routing policy name.');
      }
      allowedRoutingPolicies.push(value);
      index++;
      continue;
    }

    if (arg.startsWith('--allow-route=')) {
      const value = arg.slice('--allow-route='.length).trim();
      if (!value) {
        throw new Error('--allow-route requires a routing policy name.');
      }
      allowedRoutingPolicies.push(value);
      continue;
    }

    if (arg === '--role') {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith('--')) {
        throw new Error('--role requires user, operator, or admin.');
      }
      role = CredentialRoleSchema.parse(value);
      index++;
      continue;
    }

    if (arg.startsWith('--role=')) {
      const value = arg.slice('--role='.length).trim();
      if (!value) {
        throw new Error('--role requires user, operator, or admin.');
      }
      role = CredentialRoleSchema.parse(value);
      continue;
    }

    if (arg === '--admin') {
      administrative = true;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown credentials issue option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length > 2) usage();

  const name = positional[0]?.trim() || undefined;
  let ttlMs: number | undefined;
  if (positional[1] !== undefined) {
    const seconds = Number(positional[1]);
    if (
      !Number.isInteger(seconds) ||
      seconds < 1 ||
      seconds > 31_536_000
    ) {
      throw new Error(
        'ttl_seconds must be an integer between 1 and 31536000.',
      );
    }
    ttlMs = seconds * 1000;
  }

  if (
    scope !== 'mcp' &&
    (allowedTools.length > 0 ||
      allowedDeviceIds.length > 0 ||
      allowedRoutingPolicies.length > 0 ||
      administrative ||
      (role !== undefined && role !== 'user'))
  ) {
    throw new Error(
      '--allow-tool, --allow-device, --allow-route, non-user --role values, and --admin are supported only for MCP credentials.',
    );
  }

  return {
    ...(name ? { name } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    ...(allowedDeviceIds.length > 0 ? { allowedDeviceIds } : {}),
    ...(allowedRoutingPolicies.length > 0
      ? { allowedRoutingPolicies }
      : {}),
    ...(role ? { role } : {}),
    ...(administrative ? { administrative: true } : {}),
  };
}

export async function runCredentialCommand(
  config: NexowireConfig,
  args: readonly string[],
): Promise<void> {
  const store = new CredentialStore(config.stateDir);
  await store.initialize();

  const command = args[0];
  if (command === 'list') {
    const scopeArg = args[1];
    const scope = scopeArg
      ? CredentialScopeSchema.parse(scopeArg)
      : undefined;
    process.stdout.write(
      JSON.stringify(
        {
          credentials: store.list({
            ...(scope ? { scope } : {}),
            includeRevoked: true,
          }),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (command === 'issue') {
    const scope = CredentialScopeSchema.parse(args[1]);
    const issued = await store.issue(
      scope,
      parseIssueOptions(scope, args.slice(2)),
    );
    process.stdout.write(
      JSON.stringify(
        {
          ...issued,
          warning:
            'The token is shown once. Store it securely; Nexowire persists only its hash.',
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (command === 'revoke') {
    const id = args[1];
    if (!id) usage();
    process.stdout.write(
      JSON.stringify(
        {
          credential: await store.revoke(id),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  usage();
}
