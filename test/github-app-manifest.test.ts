import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGitHubAppManifest,
  exchangeGitHubAppManifestCode,
} from '../src/product/github-app-manifest.js';

test('GitHub App manifest requests no repository permissions and pins setup/login callbacks', () => {
  const manifest = buildGitHubAppManifest({
    origin: 'https://control.example.test/',
    suggestedName: 'Nexowire-test',
  });

  assert.deepEqual(manifest.default_permissions, {});
  assert.deepEqual(manifest.default_events, []);
  assert.equal(manifest.public, true);
  assert.equal(
    manifest.redirect_url,
    'https://control.example.test/setup/github/callback',
  );
  assert.deepEqual(
    manifest.callback_urls,
    [
      'https://control.example.test/auth/github/callback',
    ],
  );
  assert.equal(
    manifest.request_oauth_on_install,
    false,
  );
});

test('GitHub App manifest exchange returns only OAuth credentials needed by Nexowire', async () => {
  const calls: string[] = [];
  const credentials =
    await exchangeGitHubAppManifestCode(
      'manifest-code-12345678',
      async (input, init) => {
        calls.push(String(input));
        assert.equal(init?.method, 'POST');
        const headers = new Headers(init?.headers);
        assert.equal(
          headers.get('authorization'),
          null,
        );
        return Response.json(
          {
            id: 123,
            slug: 'nexowire-test',
            client_id: 'Iv1.test-client',
            client_secret: 'test-client-secret',
            webhook_secret: 'discard-me',
            pem: 'discard-me-too',
          },
          { status: 201 },
        );
      },
    );

  assert.deepEqual(credentials, {
    appId: 123,
    slug: 'nexowire-test',
    clientId: 'Iv1.test-client',
    clientSecret: 'test-client-secret',
  });
  assert.deepEqual(calls, [
    'https://api.github.com/app-manifests/manifest-code-12345678/conversions',
  ]);
  assert.equal(
    'pem' in (credentials as Record<string, unknown>),
    false,
  );
  assert.equal(
    'webhookSecret' in
      (credentials as Record<string, unknown>),
    false,
  );
});

test('GitHub App manifest rejects insecure origins and malformed conversion codes', async () => {
  assert.throws(
    () =>
      buildGitHubAppManifest({
        origin: 'http://control.example.test/',
        suggestedName: 'Nexowire',
      }),
    /clean HTTPS origin/,
  );

  await assert.rejects(
    exchangeGitHubAppManifestCode('bad code'),
    /manifest code is invalid/,
  );
});
