import test from 'node:test';
import assert from 'node:assert/strict';
import { redactDiagnosticText } from '../../../src/protocol/error-contract-v2.ts';

// #539 R01/R13, source-only negative. Synthetic Basic credentials are reversible
// base64; do not treat a masked "Basic" scheme word as redaction of the value.
// No network listener, real account, or HTTP credential is used.
const fakePassword = 'NW_SYNTHETIC_BASIC_PASSWORD_20261120';
const basicValue = Buffer.from('k08-probe:' + fakePassword, 'utf8').toString('base64');

test('diagnostic Authorization Basic field must not echo encoded credentials', () => {
  const output = redactDiagnosticText('Authorization: Basic ' + basicValue);
  assert.ok(!output.includes(basicValue),
    'SOURCE_RED: the full reversible Basic credential remains after scheme-only redaction');
});

test('existing Bearer redaction and unrelated text remain intact', () => {
  const bearer = 'NW_SYNTHETIC_BEARER_20261120';
  const output = redactDiagnosticText('Authorization: Bearer ' + bearer);
  assert.ok(!output.includes(bearer), 'Bearer token should remain redacted');
  assert.equal(redactDiagnosticText('request-id: k08-123'), 'request-id: k08-123');
});
