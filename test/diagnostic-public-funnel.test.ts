import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve4 } from 'node:dns/promises';

// Temporary diagnostic PR only. Never merge this external availability check:
// it would make every normal CI dependent on an unrelated public relay.
test('diagnostic: public Funnel TLS from GitHub hosted Linux', {
  skip: process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux',
  timeout: 75_000,
}, async (t) => {
  const name = 'nexowire.tail10f02d.ts.net';
  try {
    const addresses = await resolve4(name);
    t.diagnostic('PUBLIC_DNS_A=' + addresses.join(','));
  } catch (error) {
    t.diagnostic('PUBLIC_DNS_ERROR=' + String(error));
  }

  const checks: Array<[string, number]> = [
    ['https://nexowire-control-plane.nexowire-naveax.workers.dev/health', 200],
    ['https://nexowire-control-plane.nexowire-naveax.workers.dev/api/v1/public/usage-policy', 200],
    ['https://nexowire.tail10f02d.ts.net/health', 200],
    ['https://nexowire.tail10f02d.ts.net/.well-known/oauth-protected-resource/mcp', 200],
    ['https://nexowire.tail10f02d.ts.net/mcp', 401],
  ];
  const failures: string[] = [];
  for (const [url, expected] of checks) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(12_000),
        redirect: 'manual',
        cache: 'no-store',
      });
      t.diagnostic(url + ' STATUS=' + response.status);
      if (response.status !== expected) failures.push(url + ': expected ' + expected + ', got ' + response.status);
    } catch (error) {
      const cause = error instanceof Error ? String(error.cause ?? error.message) : String(error);
      t.diagnostic(url + ' FAILED=' + cause.slice(0, 320));
      failures.push(url + ': ' + cause.slice(0, 180));
    }
  }
  assert.deepEqual(failures, [], 'Externally reachable HTTPS ingress must pass');
});
