import assert from 'node:assert/strict';
import { redactDiagnosticValue } from '../../../src/protocol/error-contract-v2.ts';

// Explicitly invoked, offline, synthetic-only probe. Do not add to generic CI
// before the security owner decides whether raw headers reach this boundary.
const marker = 'NW_SYNTHETIC_COOKIE_VALUE_0123456789';
const baseline = redactDiagnosticValue({
  authorization: `Bearer ${marker}`,
  token: marker,
  harmless: 'preserved',
});
assert.equal(JSON.stringify(baseline).includes(marker), false,
  'Baseline authorization/token redaction must still work');
assert.equal(baseline.harmless, 'preserved');

const candidate = redactDiagnosticValue({
  headers: {
    Cookie: `session_id=${marker}`,
    'Set-Cookie': `session_id=${marker}; HttpOnly; SameSite=Strict`,
  },
});
const leaked = JSON.stringify(candidate).includes(marker);
if (leaked) {
  console.error('RED: synthetic Cookie/Set-Cookie diagnostic values remain in the redactor output.');
  console.error('Scope: redactor-only reproduction; real MCP header flow NOT_PROVEN.');
  process.exitCode = 1;
} else {
  console.log('PASS: synthetic Cookie/Set-Cookie values masked at redactor boundary.');
}


// W-723: common secret-bearing HTTP header ALIASES are distinct from the
// previously reported Cookie case. Each value is synthetic; no header is sent.
const aliasMarker = 'NW_SYNTHETIC_ALIAS_VALUE_0123456789';
const aliases = ['x-api-key', 'Proxy-Authorization', 'X-Auth-Token'];
const aliasResult = redactDiagnosticValue({
  headers: Object.fromEntries(aliases.map(name => [name, aliasMarker])),
});
const exposedAliases = aliases.filter(name =>
  String(aliasResult.headers[name]).includes(aliasMarker));
const aliasBaseline = redactDiagnosticValue({
  headers: { Authorization: aliasMarker, 'Api-Key': aliasMarker, 'X-Request-ID': 'request-123' },
});
assert.equal(String(aliasBaseline.headers.Authorization).includes(aliasMarker), false,
  'Existing Authorization header control must stay masked');
assert.equal(String(aliasBaseline.headers['Api-Key']).includes(aliasMarker), false,
  'Existing Api-Key header control must stay masked');
assert.equal(aliasBaseline.headers['X-Request-ID'], 'request-123',
  'Non-sensitive request correlation must not be erased');

if (exposedAliases.length > 0) {
  console.error(`RED: ${exposedAliases.join(', ')} header alias value(s) remain unmasked.`);
  console.error('Scope: synthetic redactor object only. Incoming headers to MCP response NOT_PROVEN.');
  process.exitCode = 1;
} else {
  console.log('PASS: secret-bearing header alias values masked at redactor boundary.');
}
