import { promises as fs } from 'node:fs';
import {
  defaultLemonSqueezyProvisioningPaths,
  ensureLemonSqueezyWebhook,
  generateLemonSqueezyWebhookSecret,
  optionalReadLemonSqueezyProvisioningState,
  parsePrepaidPackSpec,
  readLemonSqueezyProvisioningState,
  validateLemonSqueezyCatalog,
  writeLemonSqueezyProvisioningState,
  type LemonSqueezyPrepaidPack,
} from '../src/product/lemon-squeezy-provisioning.js';
import {
  readProtectedSecretFile,
  writeProtectedSecretFile,
} from '../src/security/protected-secret-files.js';

interface Options {
  apply: boolean;
  storeId?: string;
  plusVariantId?: string;
  proVariantId?: string;
  webhookUrl?: string;
  prepaidPackSpecs: string[];
}

function help(): string {
  return [
    'Usage:',
    '  npm run billing:provision -- [--apply]',
    '    --store-id <id>',
    '    --plus-variant-id <id>',
    '    --pro-variant-id <id>',
    '    [--prepaid-pack <variantId:credits[:label]>]...',
    '    --webhook-url <https://.../api/v1/billing/webhook/lemonsqueezy>',
    '',
    'Secrets are never accepted as command-line arguments.',
    'If no protected API key exists yet, the CLI reads it from a hidden terminal prompt.',
    '--apply writes DPAPI-protected secret files, creates/updates the production webhook,',
    'and persists non-secret catalog configuration for future control-plane bootstraps.',
  ].join('\n');
}

function parseArgs(argv: string[]): Options {
  const output: Options = {
    apply: false,
    prepaidPackSpecs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(help() + '\n');
      process.exit(0);
    }
    if (arg === '--apply') {
      output.apply = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Missing value for ' + arg);
    }
    if (arg === '--store-id') {
      output.storeId = value;
    } else if (arg === '--plus-variant-id') {
      output.plusVariantId = value;
    } else if (arg === '--pro-variant-id') {
      output.proVariantId = value;
    } else if (arg === '--webhook-url') {
      output.webhookUrl = value;
    } else if (arg === '--prepaid-pack') {
      output.prepaidPackSpecs.push(value);
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
    index += 1;
  }

  return output;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

function validateSecretInput(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > 4096 ||
    /[\r\n\0]/.test(trimmed)
  ) {
    throw new Error(
      'Secret input must be one non-empty line up to 4096 characters.',
    );
  }
  return trimmed;
}

async function readHiddenSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    let value = '';
    for await (const chunk of process.stdin) {
      value += String(chunk);
    }
    return validateSecretInput(value);
  }

  const stdin = process.stdin;
  const previousRaw = stdin.isRaw;
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return await new Promise<string>((resolve, reject) => {
    let value = '';

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(previousRaw);
      stdin.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk: string | Buffer) => {
      const text = String(chunk);
      for (const char of text) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Secret input cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          try {
            resolve(validateSecretInput(value));
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdin.on('data', onData);
  });
}

function required(
  label: string,
  value: string | undefined,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      label +
        ' is required. Supply it explicitly on first provisioning or reuse an existing provisioning state.',
    );
  }
  return trimmed;
}

function normalizeWebhookUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:') {
    throw new Error('Production webhook URL must use HTTPS.');
  }
  if (
    url.pathname !==
    '/api/v1/billing/webhook/lemonsqueezy'
  ) {
    throw new Error(
      'Production webhook URL must end at /api/v1/billing/webhook/lemonsqueezy.',
    );
  }
  url.hash = '';
  return url.toString();
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error(
      'Production billing provisioning currently requires Windows owner DPAPI.',
    );
  }

  const options = parseArgs(process.argv.slice(2));
  const paths = defaultLemonSqueezyProvisioningPaths();
  const existing =
    await optionalReadLemonSqueezyProvisioningState(
      paths.configFile,
    );

  const storeId = required(
    'Lemon Squeezy store ID',
    options.storeId ?? existing?.storeId,
  );
  const plusVariantId = required(
    'Lemon Squeezy Plus variant ID',
    options.plusVariantId ?? existing?.plusVariantId,
  );
  const proVariantId = required(
    'Lemon Squeezy Pro variant ID',
    options.proVariantId ?? existing?.proVariantId,
  );
  const webhookUrl = normalizeWebhookUrl(
    required(
      'Lemon Squeezy webhook URL',
      options.webhookUrl ?? existing?.webhookUrl,
    ),
  );

  const prepaidPacks: LemonSqueezyPrepaidPack[] =
    options.prepaidPackSpecs.length > 0
      ? options.prepaidPackSpecs.map(parsePrepaidPackSpec)
      : existing?.prepaidPacks ?? [];

  const hasApiKeyFile = await exists(paths.apiKeyFile);
  const apiKey = hasApiKeyFile
    ? readProtectedSecretFile(
        paths.apiKeyFile,
        'billing-lemonsqueezy-api-key',
        'Lemon Squeezy API key',
      )
    : await readHiddenSecret(
        'Lemon Squeezy production API key: ',
      );

  const catalog = await validateLemonSqueezyCatalog({
    apiKey,
    storeId,
    plusVariantId,
    proVariantId,
    prepaidPacks,
  });

  let webhookSecret: string | undefined;
  const hasWebhookSecretFile = await exists(
    paths.webhookSecretFile,
  );
  if (hasWebhookSecretFile) {
    webhookSecret = readProtectedSecretFile(
      paths.webhookSecretFile,
      'billing-lemonsqueezy-webhook-secret',
      'Lemon Squeezy webhook secret',
    );
  } else if (options.apply) {
    webhookSecret = generateLemonSqueezyWebhookSecret();
  }

  if (options.apply && !hasApiKeyFile) {
    await writeProtectedSecretFile(
      paths.apiKeyFile,
      'billing-lemonsqueezy-api-key',
      apiKey,
    );
  }
  if (
    options.apply &&
    !hasWebhookSecretFile &&
    webhookSecret
  ) {
    await writeProtectedSecretFile(
      paths.webhookSecretFile,
      'billing-lemonsqueezy-webhook-secret',
      webhookSecret,
    );
  }

  const webhook = await ensureLemonSqueezyWebhook({
    apiKey,
    storeId,
    webhookUrl,
    webhookId: existing?.webhookId,
    webhookSecret,
    apply: options.apply,
  });

  if (options.apply) {
    if (!webhook.webhookId) {
      throw new Error(
        'Lemon Squeezy webhook provisioning did not return an ID.',
      );
    }
    await writeLemonSqueezyProvisioningState(
      paths.configFile,
      {
        version: 1,
        provider: 'lemonsqueezy',
        storeId,
        plusVariantId,
        proVariantId,
        prepaidPacks,
        webhookId: webhook.webhookId,
        webhookUrl,
        updatedAt: new Date().toISOString(),
      },
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        apply: options.apply,
        catalog,
        webhook,
        prepaidPackCount: prepaidPacks.length,
        configFile: paths.configFile,
        apiKeyFile: paths.apiKeyFile,
        webhookSecretFile: paths.webhookSecretFile,
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : String(error);
  process.stderr.write(
    JSON.stringify({
      ok: false,
      error: message,
    }) + '\n',
  );
  process.exitCode = 1;
});
