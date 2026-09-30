import type { NexowireConfig } from '../config.js';
import {
  CredentialScopeSchema,
  CredentialStore,
  type CredentialScope,
} from './credential-store.js';

function usage(): never {
  throw new Error(
    'Usage: nexowire credentials list [mcp|agent] | issue <mcp|agent> [name] [ttl_seconds] [--allow-tool <pattern>]... | revoke <id>',
  );
}

function parseIssueOptions(
  scope: CredentialScope,
  args: readonly string[],
): {
  name?: string;
  ttlMs?: number;
  allowedTools?: string[];
} {
  const positional: string[] = [];
  const allowedTools: string[] = [];

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

  if (scope !== 'mcp' && allowedTools.length > 0) {
    throw new Error(
      '--allow-tool is supported only for MCP credentials.',
    );
  }

  return {
    ...(name ? { name } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
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
