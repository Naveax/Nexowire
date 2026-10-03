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
        },
        encoding: 'utf8',
      },
    );
    const summary = JSON.parse(stdout) as {
      requiredSecrets: string[];
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
    assert.equal(
      runtime.vars.NEXOWIRE_ADMIN_GITHUB_ID,
      '123456',
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
