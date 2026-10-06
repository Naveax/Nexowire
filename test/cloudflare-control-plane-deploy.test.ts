import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Cloudflare runtime config generator injects D1, vars and required secret names without secret values', async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-cf-config-'),
  );
  const template = path.join(dir, 'wrangler.jsonc');
  const output = path.join(dir, 'runtime.json');

  await fs.writeFile(
    template,
    JSON.stringify({
      name: 'nexowire-control-plane',
      main: './cloudflare/worker.js',
      assets: {
        directory: './web',
        binding: 'ASSETS',
      },
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'nexowire-control-plane',
          database_id: 'REPLACE_WITH_D1_DATABASE_ID',
        },
      ],
    }),
  );

  try {
    const stdout = execFileSync(
      process.execPath,
      [
        path.join(
          process.cwd(),
          'scripts',
          'prepare-cloudflare-control-plane.mjs',
        ),
        template,
        output,
      ],
      {
        env: {
          ...process.env,
          NEXOWIRE_D1_DATABASE_ID:
            '11111111-2222-4333-8444-555555555555',
          NEXOWIRE_AGENT_WS_URL:
            'wss://relay.example.test/agent',
          NEXOWIRE_MCP_RESOURCE_URL:
            'https://relay.example.test/mcp',
          NEXOWIRE_ADMIN_GITHUB_ID: '123456',
          NEXOWIRE_FREE_CAPACITY_PERCENT: '75',
          NEXOWIRE_PAID_BILLING_ENABLED: 'false',
          NEXOWIRE_LEMONSQUEEZY_STORE_ID: '1001',
          NEXOWIRE_LEMONSQUEEZY_PLUS_VARIANT_ID: '2001',
          NEXOWIRE_LEMONSQUEEZY_PRO_VARIANT_ID: '2002',
          NEXOWIRE_LEMONSQUEEZY_PREPAID_PACKS_JSON:
            JSON.stringify([
              {
                variantId: '3001',
                credits: 100000,
                label: '100k kredi',
              },
            ]),
        },
        encoding: 'utf8',
      },
    );
    const summary = JSON.parse(stdout) as {
      requiredSecrets: string[];
      optionalSecrets: string[];
    };

    const runtime = JSON.parse(
      await fs.readFile(output, 'utf8'),
    ) as {
      d1_databases: Array<Record<string, unknown>>;
      vars: Record<string, string>;
      secrets?: unknown;
    };

    assert.equal(
      runtime.d1_databases[0]?.database_id,
      '11111111-2222-4333-8444-555555555555',
    );
    assert.equal(
      runtime.d1_databases[0]?.migrations_dir,
      './cloudflare/migrations',
    );
    assert.equal(
      runtime.vars.NEXOWIRE_AGENT_WS_URL,
      'wss://relay.example.test/agent',
    );
    assert.equal(
      runtime.vars.NEXOWIRE_MCP_RESOURCE_URL,
      'https://relay.example.test/mcp',
    );
    assert.equal(
      runtime.vars.NEXOWIRE_FREE_CAPACITY_PERCENT,
      '75',
    );
    assert.equal(runtime.vars.NEXOWIRE_PAID_BILLING_ENABLED, 'false');
    assert.equal(
      runtime.vars.NEXOWIRE_ADMIN_GITHUB_ID,
      '123456',
    );
    assert.equal(
      runtime.vars.NEXOWIRE_LEMONSQUEEZY_STORE_ID,
      '1001',
    );
    assert.equal(
      runtime.vars.NEXOWIRE_LEMONSQUEEZY_PLUS_VARIANT_ID,
      '2001',
    );
    assert.equal(
      runtime.vars.NEXOWIRE_LEMONSQUEEZY_PRO_VARIANT_ID,
      '2002',
    );
    assert.equal(
      runtime.vars.NEXOWIRE_LEMONSQUEEZY_PREPAID_PACKS_JSON,
      JSON.stringify([
        {
          variantId: '3001',
          credits: 100000,
          label: '100k kredi',
        },
      ]),
    );
    assert.equal(runtime.secrets, undefined);
    assert.deepEqual(
      summary.requiredSecrets,
      [
        'NEXOWIRE_SESSION_SECRET',
        'NEXOWIRE_INTERNAL_SERVICE_TOKEN',
        'NEXOWIRE_CONFIG_ENCRYPTION_KEY',
      ],
    );
    assert.deepEqual(
      summary.optionalSecrets,
      [
        'NEXOWIRE_LEMONSQUEEZY_API_KEY',
        'NEXOWIRE_LEMONSQUEEZY_WEBHOOK_SECRET',
      ],
    );

    const serialized = JSON.stringify(runtime);
    assert.equal(
      serialized.includes('CLIENT_SECRET_VALUE'),
      false,
    );
    assert.equal(
      serialized.includes('SESSION_SECRET_VALUE'),
      false,
    );
  } finally {
    await fs.rm(dir, {
      recursive: true,
      force: true,
    });
  }
});

test('Cloudflare runtime config generator rejects insecure or wrong-path hosted endpoints', async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-cf-config-'),
  );
  const template = path.join(dir, 'wrangler.jsonc');
  const output = path.join(dir, 'runtime.json');

  await fs.writeFile(
    template,
    JSON.stringify({
      name: 'nexowire-control-plane',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'nexowire-control-plane',
          database_id: 'placeholder',
        },
      ],
    }),
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(
          process.cwd(),
          'scripts',
          'prepare-cloudflare-control-plane.mjs',
        ),
        template,
        output,
      ],
      {
        env: {
          ...process.env,
          NEXOWIRE_D1_DATABASE_ID:
            '11111111-2222-4333-8444-555555555555',
          NEXOWIRE_AGENT_WS_URL:
            'ws://relay.example.test/agent',
          NEXOWIRE_MCP_RESOURCE_URL:
            'https://relay.example.test/not-mcp',
        },
        encoding: 'utf8',
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr + result.stdout,
      /NEXOWIRE_AGENT_WS_URL|NEXOWIRE_MCP_RESOURCE_URL/,
    );
  } finally {
    await fs.rm(dir, {
      recursive: true,
      force: true,
    });
  }
});

test('D1 quota triggers stay compatible with the remote migration splitter', async () => {
  for (const name of [
    '0001_control_plane.sql',
    '0003_quota_subject_device_anchor.sql',
    '0008_prepaid_credit_balance.sql',
  ]) {
    const migration = await fs.readFile(
      path.join(
        process.cwd(),
        'cloudflare',
        'migrations',
        name,
      ),
      'utf8',
    );

    const triggerStart = migration.indexOf('CREATE TRIGGER');
    assert.notEqual(triggerStart, -1, name);
    const trigger = migration.slice(triggerStart);

    assert.equal(migration.includes('\r'), false, name);
    assert.equal(trigger.includes('SELECT CASE'), false, name);
    assert.equal(
      (
        trigger.match(
          /SELECT RAISE\(ABORT, 'quota_exhausted'\)/g,
        ) ?? []
      ).length,
      2,
      name,
    );
    assert.match(trigger, /\nBEGIN\n/, name);
  }
});


test('Cloudflare runtime config generator rejects malformed or colliding prepaid pack config', async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-cf-prepaid-config-'),
  );
  const template = path.join(dir, 'wrangler.jsonc');
  const output = path.join(dir, 'runtime.json');

  await fs.writeFile(
    template,
    JSON.stringify({
      name: 'nexowire-control-plane',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'nexowire-control-plane',
          database_id: 'placeholder',
        },
      ],
    }),
  );

  const baseEnv = {
    ...process.env,
    NEXOWIRE_D1_DATABASE_ID:
      '11111111-2222-4333-8444-555555555555',
    NEXOWIRE_AGENT_WS_URL:
      'wss://relay.example.test/agent',
    NEXOWIRE_MCP_RESOURCE_URL:
      'https://relay.example.test/mcp',
    NEXOWIRE_LEMONSQUEEZY_STORE_ID: '1001',
    NEXOWIRE_LEMONSQUEEZY_PLUS_VARIANT_ID: '2001',
    NEXOWIRE_LEMONSQUEEZY_PRO_VARIANT_ID: '2002',
  };

  try {
    for (const bad of [
      '{not-json',
      JSON.stringify([
        { variantId: '2001', credits: 1000 },
      ]),
      JSON.stringify([
        { variantId: '3001', credits: 0 },
      ]),
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          path.join(
            process.cwd(),
            'scripts',
            'prepare-cloudflare-control-plane.mjs',
          ),
          template,
          output,
        ],
        {
          env: {
            ...baseEnv,
            NEXOWIRE_LEMONSQUEEZY_PREPAID_PACKS_JSON:
              bad,
          },
          encoding: 'utf8',
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr + result.stdout,
        /prepaid/i,
      );
    }
  } finally {
    await fs.rm(dir, {
      recursive: true,
      force: true,
    });
  }
});

test('Cloudflare runtime config generator rejects partial Lemon Squeezy billing vars', async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-cf-billing-config-'),
  );
  const template = path.join(dir, 'wrangler.jsonc');
  const output = path.join(dir, 'runtime.json');

  await fs.writeFile(
    template,
    JSON.stringify({
      name: 'nexowire-control-plane',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'nexowire-control-plane',
          database_id: 'placeholder',
        },
      ],
    }),
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(
          process.cwd(),
          'scripts',
          'prepare-cloudflare-control-plane.mjs',
        ),
        template,
        output,
      ],
      {
        env: {
          ...process.env,
          NEXOWIRE_D1_DATABASE_ID:
            '11111111-2222-4333-8444-555555555555',
          NEXOWIRE_AGENT_WS_URL:
            'wss://relay.example.test/agent',
          NEXOWIRE_MCP_RESOURCE_URL:
            'https://relay.example.test/mcp',
          NEXOWIRE_LEMONSQUEEZY_STORE_ID: '1001',
        },
        encoding: 'utf8',
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr + result.stdout,
      /billing vars must be configured together/i,
    );
  } finally {
    await fs.rm(dir, {
      recursive: true,
      force: true,
    });
  }
});


test('GitHub Actions deployment reuses existing D1 and never creates production infrastructure automatically', async () => {
  const workflow = await fs.readFile(
    path.join(
      process.cwd(),
      '.github',
      'workflows',
      'deploy-control-plane.yml',
    ),
    'utf8',
  );

  assert.match(
    workflow,
    /Resolve existing D1 database/,
  );
  assert.equal(
    workflow.includes(
      'wrangler@4 d1 create nexowire-control-plane',
    ),
    false,
  );
  assert.match(
    workflow,
    /CI will not create infrastructure automatically/,
  );
});
