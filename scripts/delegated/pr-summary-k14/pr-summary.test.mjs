import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect, sensitivePath, summarize, markdown } from './pr-summary.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const pr = { number: 1022, title: 'example', state: 'open', draft: true, mergeable: null, head: { sha: HEAD }, base: { sha: BASE } };
const clean = { before: pr, after: pr, files: [{ filename: 'docs/a.md' }], filesComplete: true,
  runs: [{ head_sha: HEAD, status: 'completed', conclusion: 'success', jobs: [{ conclusion: 'success' }] }], runsComplete: true, jobsComplete: true };

test('classify sensitive ownership paths conservatively', () => {
  assert.equal(sensitivePath('src/agent/operation-journal.ts'), true);
  assert.equal(sensitivePath('src/security/verify.ts'), true);
  assert.equal(sensitivePath('.github/workflows/ci.yml'), true);
  assert.equal(sensitivePath('docs/delegated/friendly.md'), false);
});
test('even all-green synthetic CI cannot approve merge', () => {
  const result = summarize(clean);
  assert.equal(result.ci, 'OBSERVED_GREEN_JOBS_NOT_MERGE_APPROVAL');
  assert.equal(result.acceptance, 'NOT_APPROVED_FOR_MERGE');
  assert.equal(result.review, 'NOT_CHECKED');
  assert.match(markdown(result), /Draft PR/);
});
test('refuses stale head and incomplete pagination', () => {
  const stale = summarize({ ...clean, after: { ...pr, head: { sha: 'c'.repeat(40) } } });
  assert.equal(stale.ci, 'HEAD_CHANGED_RETRY');
  const incomplete = summarize({ ...clean, jobsComplete: false, filesComplete: false });
  assert.equal(incomplete.ci, 'UNVERIFIED_INCOMPLETE_PAGINATION');
  assert.ok(incomplete.reasons.some(v => v.includes('Truncated')));
});
test('flags critical paths and empty action_required jobs', () => {
  const result = summarize({ ...clean, files: [{ filename: 'src/security/credentials.ts' }],
    runs: [{ head_sha: HEAD, status: 'completed', conclusion: 'action_required', jobs: [] }] });
  assert.equal(result.ci, 'ACTION_REQUIRED_EMPTY_JOBS');
  assert.deepEqual(result.flaggedPaths, ['src/security/credentials.ts']);
});
test('double-checks PR head after all GET-only evidence reads', async () => {
  const paths = [];
  let reads = 0;
  const get = async path => {
    paths.push(path);
    if (path.endsWith('/pulls/1022')) { reads++; return pr; }
    if (path.includes('/pulls/1022/files')) return [{ filename: 'docs/a.md' }];
    if (path.includes('/actions/runs?')) return { workflow_runs: [{ id: 3, head_sha: HEAD, status: 'completed', conclusion: 'action_required' }] };
    if (path.includes('/actions/runs/3/jobs')) return { jobs: [] };
    throw new Error(`unexpected path ${path}`);
  };
  const result = await inspect(get, 'Naveax/Nexowire', 1022);
  assert.equal(reads, 2);
  assert.equal(result.ci, 'ACTION_REQUIRED_EMPTY_JOBS');
  assert.ok(paths.every(path => path.startsWith('/repos/')));
});
test('rejects invalid inputs and incomplete PR snapshots', async () => {
  await assert.rejects(inspect(async () => pr, 'Naveax/Nexowire', 0), /Invalid repository or PR/);
  assert.throws(() => summarize({ ...clean, after: { ...pr, head: { sha: 'short' } } }), /Invalid or incomplete/);
});
