import { promises as fs } from 'node:fs';
import path from 'node:path';

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(name + ' is required.');
  }
  return value;
}

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

const REQUIRED_SECRETS = [
  'NEXOWIRE_SESSION_SECRET',
  'NEXOWIRE_INTERNAL_SERVICE_TOKEN',
  'NEXOWIRE_CONFIG_ENCRYPTION_KEY',
];

const OPTIONAL_BILLING_SECRETS = [
  'NEXOWIRE_LEMONSQUEEZY_API_KEY',
  'NEXOWIRE_LEMONSQUEEZY_WEBHOOK_SECRET',
];

const BILLING_VAR_NAMES = [
  'NEXOWIRE_LEMONSQUEEZY_STORE_ID',
  'NEXOWIRE_LEMONSQUEEZY_PLUS_VARIANT_ID',
  'NEXOWIRE_LEMONSQUEEZY_PRO_VARIANT_ID',
];

function optionalBillingVars() {
  const values = Object.fromEntries(
    BILLING_VAR_NAMES.map((name) => [
      name,
      optionalEnv(name),
    ]),
  );
  const present = BILLING_VAR_NAMES.filter(
    (name) => values[name] !== undefined,
  );
  if (present.length === 0) return {};
  if (present.length !== BILLING_VAR_NAMES.length) {
    throw new Error(
      'Lemon Squeezy billing vars must be configured together.',
    );
  }
  for (const name of BILLING_VAR_NAMES) {
    if (!/^\d+$/.test(values[name])) {
      throw new Error(name + ' must be a numeric ID.');
    }
  }
  if (
    values.NEXOWIRE_LEMONSQUEEZY_PLUS_VARIANT_ID ===
    values.NEXOWIRE_LEMONSQUEEZY_PRO_VARIANT_ID
  ) {
    throw new Error(
      'Lemon Squeezy Plus and Pro variant IDs must differ.',
    );
  }
  return values;
}

function boundedPercent(raw) {
  if (raw === undefined) return '0';
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(
      'NEXOWIRE_FREE_CAPACITY_PERCENT must be between 0 and 100.',
    );
  }
  return String(value);
}

function validateUrl(name, raw, protocol) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(name + ' must be a valid URL.');
  }

  if (
    url.protocol !== protocol ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      name + ' must use ' + protocol + ' without embedded credentials or fragments.',
    );
  }

  return url.toString();
}

async function main() {
  const databaseId = requiredEnv(
    'NEXOWIRE_D1_DATABASE_ID',
  );
  if (
    !/^[0-9a-f-]{16,64}$/i.test(databaseId)
  ) {
    throw new Error(
      'NEXOWIRE_D1_DATABASE_ID has an invalid format.',
    );
  }

  const agentUrl = validateUrl(
    'NEXOWIRE_AGENT_WS_URL',
    requiredEnv('NEXOWIRE_AGENT_WS_URL'),
    'wss:',
  );
  const mcpResourceUrl = validateUrl(
    'NEXOWIRE_MCP_RESOURCE_URL',
    requiredEnv('NEXOWIRE_MCP_RESOURCE_URL'),
    'https:',
  );
  if (new URL(agentUrl).pathname !== '/agent') {
    throw new Error(
      'NEXOWIRE_AGENT_WS_URL must end in /agent.',
    );
  }
  if (new URL(mcpResourceUrl).pathname !== '/mcp') {
    throw new Error(
      'NEXOWIRE_MCP_RESOURCE_URL must end in /mcp.',
    );
  }

  const templatePath =
    process.argv[2] ??
    'cloudflare/wrangler.jsonc';
  const outputPath =
    process.argv[3] ??
    'wrangler.runtime.json';

  const template = JSON.parse(
    await fs.readFile(templatePath, 'utf8'),
  );

  if (
    !Array.isArray(template.d1_databases) ||
    template.d1_databases.length !== 1
  ) {
    throw new Error(
      'Wrangler template must define exactly one D1 database.',
    );
  }

  template.d1_databases[0] = {
    ...template.d1_databases[0],
    database_id: databaseId,
    migrations_dir: './cloudflare/migrations',
  };

  const billingVars = optionalBillingVars();

  template.vars = {
    NEXOWIRE_AGENT_WS_URL: agentUrl,
    NEXOWIRE_MCP_RESOURCE_URL: mcpResourceUrl,
    NEXOWIRE_FREE_CAPACITY_PERCENT:
      boundedPercent(
        optionalEnv(
          'NEXOWIRE_FREE_CAPACITY_PERCENT',
        ),
      ),
    ...billingVars,
    ...(optionalEnv('NEXOWIRE_ADMIN_GITHUB_ID')
      ? {
          NEXOWIRE_ADMIN_GITHUB_ID:
            optionalEnv(
              'NEXOWIRE_ADMIN_GITHUB_ID',
            ),
        }
      : {}),
  };

  await fs.mkdir(
    path.dirname(outputPath),
    { recursive: true },
  );
  await fs.writeFile(
    outputPath,
    JSON.stringify(template, null, 2) + '\n',
    'utf8',
  );

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        outputPath,
        workerName: template.name,
        databaseName:
          template.d1_databases[0].database_name,
        vars: Object.keys(template.vars).sort(),
        requiredSecrets: REQUIRED_SECRETS,
        optionalSecrets: OPTIONAL_BILLING_SECRETS,
      },
      null,
      2,
    ) + '\n',
  );
}

await main();
