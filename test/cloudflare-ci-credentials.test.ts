import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCloudflareAccountId,
  normalizeGitHubRepositorySlug,
  parseD1DatabaseId,
  parseWranglerWhoamiAccount,
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
