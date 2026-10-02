import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredHttpAllowedHosts } from '../src/mcp/http.js';

test('HTTP host allowlist is opt-in and preserves loopback hosts', () => {
  assert.equal(configuredHttpAllowedHosts({}), undefined);

  assert.deepEqual(
    configuredHttpAllowedHosts({
      NEXOWIRE_HTTP_ALLOWED_HOSTS:
        'Desktop-ONDD84S.tail10f02d.ts.net',
    }),
    [
      '127.0.0.1',
      'localhost',
      '[::1]',
      'desktop-ondd84s.tail10f02d.ts.net',
    ],
  );
});

test('HTTP host allowlist rejects broad or path-like entries', () => {
  for (const value of [
    '*',
    'example.test/path',
    'example.test\\path',
    'bad host.test',
  ]) {
    assert.throws(
      () =>
        configuredHttpAllowedHosts({
          NEXOWIRE_HTTP_ALLOWED_HOSTS: value,
        }),
      /explicit hostnames only/,
    );
  }
});
