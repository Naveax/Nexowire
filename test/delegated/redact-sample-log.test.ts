import test from 'node:test';
import assert from 'node:assert/strict';
import {redactSampleLog, type SyntheticSample} from '../../scripts/delegated/redact-sample-log.js';

const cases: [string,string,string[]][] = [
  ['bearer', 'Bearer synthetic.bearer-123', ['synthetic.bearer-123']],
  ['authorization', 'Authorization: Bearer fake-header-234', ['fake-header-234']],
  ['basic', 'Proxy-Authorization: Basic ZmFrZS1vbmx5', ['ZmFrZS1vbmx5']],
  ['JSON', '{"access_token":"fake-access-345","refresh_token":"fake-refresh-456"}', ['fake-access-345','fake-refresh-456']],
  ['API', 'x-api-key=fake-key-567; apiKey: fake-camel-678', ['fake-key-567','fake-camel-678']],
  ['query', '?token=fake-query-789&client_secret=fake-secret-890', ['fake-query-789','fake-secret-890']],
  ['Windows', String.raw`path="C:\Users\Synthetic Person\private\log.txt"`, ['Synthetic Person','private','log.txt']],
  ['JSON Windows', JSON.stringify({path:String.raw`C:\Users\synthetic-json\private.txt`}), ['synthetic-json','private.txt']],
  ['Unix', 'path=/home/synthetic-user/private.txt', ['synthetic-user','private.txt']],
  ['macOS', 'path="/Users/Synthetic Person/private.txt"', ['Synthetic Person','private.txt']],
  ['email', 'device=synthetic.device@example.invalid', ['synthetic.device@example.invalid']],
  ['mixed case', 'AUTHORIZATION="Custom FAKE-secret-999"', ['FAKE-secret-999']],
  ['single quoted', "token='fake spaced value'", ['fake spaced value']],
];
for (const [name,text,secrets] of cases) test('synthetic redaction: '+name, () => {
  const result = redactSampleLog({kind:'synthetic',text});
  for (const secret of secrets) assert.equal(result.text.includes(secret), false, secret);
  assert.ok(result.replacements > 0);
  assert.deepEqual(result.warnings, ['MANUAL_REVIEW_REQUIRED']);
});
test('unknown opaque formats always require review', () => {
  const r=redactSampleLog({kind:'synthetic',text:'customCredential FAKE_OPAQUE_VALUE'});
  assert.equal(r.text,'customCredential FAKE_OPAQUE_VALUE');
  assert.deepEqual(r.warnings,['MANUAL_REVIEW_REQUIRED']);
});
test('preserves non-sensitive diagnostic semantics', () => {
  assert.equal(redactSampleLog({kind:'synthetic',text:'HTTP 409 exitCode=1 unknown timeout'}).text,
    'HTTP 409 exitCode=1 unknown timeout');
});
test('rejects undeclared or real input envelopes', () => {
  for (const value of [{kind:'real',text:'fake'}, {text:'fake'},null,{kind:'synthetic',text:2}])
    assert.throws(()=>redactSampleLog(value as SyntheticSample),TypeError);
});
test('bounded input', () => {
  assert.throws(()=>redactSampleLog({kind:'synthetic',text:'x'.repeat(1_000_001)}),RangeError);
});
test('empty sample remains explicitly synthetic', () => {
  assert.equal(redactSampleLog({kind:'synthetic',text:''}).kind,'synthetic');
});
test('deterministic and no mutation of input', () => {
  const sample=Object.freeze({kind:'synthetic' as const,text:'token=fake-stable'});
  assert.deepEqual(redactSampleLog(sample),redactSampleLog(sample));
  assert.equal(sample.text,'token=fake-stable');
});
