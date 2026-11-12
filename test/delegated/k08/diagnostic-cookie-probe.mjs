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
