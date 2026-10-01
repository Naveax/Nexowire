import {
  inspectProtectedSecretFile,
  writeProtectedSecretFile,
} from './protected-secret-files.js';

export const PROTECTED_SECRET_PURPOSES = [
  'mcp-bearer-token',
  'mcp-bearer-token-list',
  'agent-bearer-token',
  'agent-bearer-token-list',
  'relay-inbound-agent-token',
  'relay-inbound-agent-token-list',
  'relay-upstream-agent-token',
] as const;

function usage(): string {
  return [
    'Nexowire protected secrets',
    '',
    'Usage:',
    '  nexowire secrets purposes',
    '  nexowire secrets inspect <file>',
    '  nexowire secrets seal <purpose> <file> [--overwrite]',
    '',
    'seal reads the plaintext secret from stdin and never accepts it as a command-line argument.',
    '',
  ].join('\n');
}

async function readStdinBounded(
  maxBytes = 1_048_576,
): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      'Protected-secret sealing requires plaintext on stdin; command-line secret arguments are intentionally unsupported.',
    );
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new Error(
        'Protected-secret input exceeds the 1 MiB bound.',
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function runProtectedSecretCommand(
  args: string[],
): Promise<void> {
  const action = args[0] ?? 'help';

  if (
    action === 'help' ||
    action === '--help' ||
    action === '-h'
  ) {
    process.stdout.write(usage());
    return;
  }

  if (action === 'purposes') {
    process.stdout.write(
      JSON.stringify(
        { purposes: PROTECTED_SECRET_PURPOSES },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (action === 'inspect') {
    const file = args[1];
    if (!file) {
      throw new Error('secrets inspect requires a file path.');
    }
    process.stdout.write(
      JSON.stringify(
        inspectProtectedSecretFile(file),
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (action === 'seal') {
    const purpose = args[1];
    const file = args[2];
    if (!purpose || !file) {
      throw new Error(
        'secrets seal requires <purpose> <file>.',
      );
    }
    if (
      !PROTECTED_SECRET_PURPOSES.includes(
        purpose as (typeof PROTECTED_SECRET_PURPOSES)[number],
      )
    ) {
      throw new Error(
        'Unsupported protected-secret purpose. Run nexowire secrets purposes.',
      );
    }

    const flags = new Set(args.slice(3));
    for (const flag of flags) {
      if (flag !== '--overwrite') {
        throw new Error(
          'Unknown secrets seal option: ' + flag,
        );
      }
    }

    const plaintext = await readStdinBounded();
    const metadata = await writeProtectedSecretFile(
      file,
      purpose,
      plaintext,
      {
        allowMultiline: purpose.endsWith('-list'),
        overwrite: flags.has('--overwrite'),
      },
    );
    process.stdout.write(
      JSON.stringify(metadata, null, 2) + '\n',
    );
    return;
  }

  throw new Error(
    'Unknown secrets command.\n\n' + usage(),
  );
}
