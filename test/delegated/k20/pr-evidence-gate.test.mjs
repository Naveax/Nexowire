import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeEvidence, markdownEvidence } from '../../../scripts/delegated/k20/pr-evidence-gate.mjs';

const headSha = 'a'.repeat(40);
const baseline = { headSha };
const ci = (conclusion, jobs, sha = headSha) => ({ headSha: sha, conclusion, jobs, runId: 1234 });

test('exact SHA is mandatory and visible in generated report', () => {
  assert.throws(() => summarizeEvidence({ headSha: '12345' }));
  assert.match(markdownEvidence(summarizeEvidence(baseline)), new RegExp(headSha));
  assert.match(markdownEvidence(summarizeEvidence(baseline)), /0\/0 successful/);
});

test('success without actual jobs is UNKNOWN, action_required is BLOCKED', () => {
  assert.equal(summarizeEvidence({ headSha, ci: ci('success', []) }).verdict, 'UNKNOWN');
  assert.equal(summarizeEvidence({ headSha, ci: ci('action_required', []) }).verdict, 'BLOCKED');
});

test('mismatched CI SHA never proves PR head, duplicates are refused', () => {
  assert.equal(summarizeEvidence({ headSha, ci: ci('success', [{ id: 1, conclusion: 'success' }], 'b'.repeat(40)) }).verdict, 'STALE');
  assert.throws(() => summarizeEvidence({ headSha, ci: ci('success', [{ id: 1 }, { id: 1 }]) }));
});

test('even all successful reported jobs need independent live GitHub verification', () => {
  const jobs = [{ id: 1, conclusion: 'success' }, { id: 2, conclusion: 'success' }];
  assert.deepEqual(summarizeEvidence({ headSha, ci: ci('success', jobs) }).jobsTotal, 2);
  assert.equal(summarizeEvidence({ headSha, ci: ci('success', jobs) }).verdict, 'REPORTED_SUCCESS_UNVERIFIED');
  assert.equal(summarizeEvidence({ headSha, ci: ci('success', [jobs[0], { id: 2, conclusion: 'cancelled' }]) }).verdict, 'FAIL');
  assert.throws(() => summarizeEvidence({ headSha, ci: ci('success', [{ conclusion: 'success' }]) }));
});
