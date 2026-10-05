import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCloudflareAccountId,
  normalizeGitHubRepositorySlug,
  OWNER_DEPLOYMENT_SECRET_SPECS,
  parseD1DatabaseId,
  parseWranglerWhoamiAccount,
  REQUIRED_GITHUB_DEPLOYMENT_SECRET_NAMES,
  resolveCloudflareCliInvocation,
} from '../src/ops/cloudflare-ci-credentials.js';

test('parses the only Wrangler account by default', () => {
  const account = parseWranglerWhoamiAccount(
    JSON.stringify({
      loggedIn: true,
      accounts: [
        {
          id: '0123456789abcdef0123456789abcdef',
          name: 'Example',
        },
      ],
    }),
  );
  assert.deepEqual(account, {
    id: '0123456789abcdef0123456789abcdef',
    name: 'Example',
  });
});

test('requires explicit account selection when Wrangler has multiple accounts', () => {
  const raw = JSON.stringify({
    loggedIn: true,
    accounts: [
      {
        id: '0123456789abcdef0123456789abcdef',
        name: 'One',
      },
      {
        id: 'fedcba9876543210fedcba9876543210',
        name: 'Two',
      },
    ],
  });
  assert.throws(
    () => parseWranglerWhoamiAccount(raw),
    /CLOUDFLARE_ACCOUNT_AMBIGUOUS:2/,
  );
  assert.equal(
    parseWranglerWhoamiAccount(
      raw,
      'fedcba9876543210fedcba9876543210',
    ).name,
    'Two',
  );
});

test('rejects an explicit account that Wrangler cannot access', () => {
  const raw = JSON.stringify({
    loggedIn: true,
    accounts: [
      {
        id: '0123456789abcdef0123456789abcdef',
        name: 'One',
      },
    ],
  });
  assert.throws(
    () =>
      parseWranglerWhoamiAccount(
        raw,
        'fedcba9876543210fedcba9876543210',
      ),
    /CLOUDFLARE_ACCOUNT_NOT_AVAILABLE/,
  );
});

test('parses the existing Nexowire D1 database id', () => {
  assert.equal(
    parseD1DatabaseId(
      JSON.stringify([
        {
          name: 'other',
          uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        },
        {
          name: 'nexowire-control-plane',
          uuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        },
      ]),
    ),
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  );
});

test('rejects missing D1 database instead of allowing CI to create a surprise resource', () => {
  assert.throws(
    () => parseD1DatabaseId('[]'),
    /CLOUDFLARE_D1_NOT_FOUND/,
  );
});

test('normalizes account and repository identifiers', () => {
  assert.equal(
    normalizeCloudflareAccountId(
      '0123456789abcdef0123456789abcdef',
    ),
    '0123456789abcdef0123456789abcdef',
  );
  assert.equal(
    normalizeGitHubRepositorySlug('Naveax/Nexowire'),
    'Naveax/Nexowire',
  );
  assert.throws(
    () => normalizeGitHubRepositorySlug('not a repo'),
  );
});


test('routes Windows npx through npm npx-cli.js instead of spawning npx.cmd', () => {
  assert.deepEqual(
    resolveCloudflareCliInvocation(
      'npx',
      ['--yes', 'wrangler@4'],
      {
        platform: 'win32',
        nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
        npmExecPath:
          'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      },
    ),
    {
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
        '--yes',
        'wrangler@4',
      ],
    },
  );
});

test('keeps GitHub CLI and non-Windows npx launches direct', () => {
  assert.deepEqual(
    resolveCloudflareCliInvocation(
      'gh',
      ['auth', 'status'],
      {
        platform: 'win32',
        nodeExecutable: 'C:\\node.exe',
      },
    ),
    {
      executable: 'gh.exe',
      args: ['auth', 'status'],
    },
  );
  assert.deepEqual(
    resolveCloudflareCliInvocation(
      'npx',
      ['--version'],
      {
        platform: 'linux',
        nodeExecutable: '/usr/bin/node',
      },
    ),
    {
      executable: 'npx',
      args: ['--version'],
    },
  );
});

test('fails closed when Windows npx cannot locate npm execution metadata', () => {
  assert.throws(
    () =>
      resolveCloudflareCliInvocation(
        'npx',
        ['--version'],
        {
          platform: 'win32',
          nodeExecutable: 'C:\\node.exe',
        },
      ),
    /NPM_EXECPATH_MISSING_FOR_NPX/,
  );
});

test('GitHub deployment secret contract includes Cloudflare and protected owner secrets', () => {
  assert.deepEqual(
    REQUIRED_GITHUB_DEPLOYMENT_SECRET_NAMES,
    [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'NEXOWIRE_SESSION_SECRET',
      'NEXOWIRE_INTERNAL_SERVICE_TOKEN',
      'NEXOWIRE_CONFIG_ENCRYPTION_KEY',
    ],
  );

  assert.deepEqual(
    OWNER_DEPLOYMENT_SECRET_SPECS.map(
      (entry) => entry.githubName,
    ),
    [
      'NEXOWIRE_SESSION_SECRET',
      'NEXOWIRE_INTERNAL_SERVICE_TOKEN',
      'NEXOWIRE_CONFIG_ENCRYPTION_KEY',
    ],
  );
  assert.equal(
    new Set(
      OWNER_DEPLOYMENT_SECRET_SPECS.map(
        (entry) => entry.fileName,
      ),
    ).size,
    OWNER_DEPLOYMENT_SECRET_SPECS.length,
  );
  assert.equal(
    new Set(
      OWNER_DEPLOYMENT_SECRET_SPECS.map(
        (entry) => entry.purpose,
      ),
    ).size,
    OWNER_DEPLOYMENT_SECRET_SPECS.length,
  );
});
