import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTailscaleStatusJson } from '../src/agent/tailscale-discovery.js';

test('tailscale discovery parser extracts connectivity and MagicDNS identity', () => {
  const parsed = parseTailscaleStatusJson(
    JSON.stringify({
      BackendState: 'Running',
      TailscaleIPs: ['100.116.23.60', 'fd7a:115c:a1e0::bd34:173d'],
      MagicDNSSuffix: 'tail10f02d.ts.net',
      Self: {
        DNSName: 'desktop-ondd84s.tail10f02d.ts.net.',
      },
    }),
  );

  assert.deepEqual(parsed, {
    running: true,
    dnsName: 'desktop-ondd84s.tail10f02d.ts.net',
    ipv4: '100.116.23.60',
    ipv6: 'fd7a:115c:a1e0::bd34:173d',
    magicDnsSuffix: 'tail10f02d.ts.net',
  });
});
