import type { NexowireConfig } from '../config.js';
import {
  CredentialScopeSchema,
  CredentialStore,
} from './credential-store.js';

function usage(): never {
  throw new Error(
    'Usage: nexowire credentials list [mcp|agent] | issue <mcp|agent> [name] [ttl_seconds] | revoke <id>',
  );
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
    const name = args[2]?.trim() || undefined;
    let ttlMs: number | undefined;
    if (args[3] !== undefined) {
      const seconds = Number(args[3]);
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

    const issued = await store.issue(scope, {
      ...(name ? { name } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    });
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
