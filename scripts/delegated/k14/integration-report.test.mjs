import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { classifySync, fileOverlaps, classifyCi, buildReport, collectSnapshot, markdownReport } from './integration-report.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

test('sync treats equal exact SHA as no-op', () => assert.equal(classifySync(A, A, null), 'IN_SYNC'));
test('sync recognizes fast-forward candidate only for fork behind', () => {
  assert.equal(classifySync(A, B, { ahead_by: 0, behind_by: 2 }), 'FORK_BEHIND_FAST_FORWARD_CANDIDATE');
  assert.equal(classifySync(A, B, { ahead_by: 1, behind_by: 0 }), 'FORK_AHEAD_NO_SYNC');
  assert.equal(classifySync(A, B, { ahead_by: 1, behind_by: 1 }), 'DIVERGED_NO_SYNC');
  assert.equal(classifySync(A, B, null), 'UNKNOWN');
  assert.equal(classifySync(A, B, { ahead_by: -1, behind_by: 2 }), 'UNKNOWN');
});
test('reject shortened SHAs and never infer a comparison', () => {
  assert.throws(() => classifySync('abc', A, null), /exact 40-character/);
  assert.equal(classifySync(A, B, { status: 'ahead' }), 'UNKNOWN');
});
test('exact path collision detection, not basename collision', () => {
  assert.deepEqual(fileOverlaps([
    { number: 1, files: ['docs/a.md', 'x/file.ts'] },
    { number: 2, files: ['docs/a.md', 'other/file.ts'] },
  ]), [{ path: 'docs/a.md', prs: [1, 2] }]);
});
test('CI refuses empty jobs, wrong SHA, missing runs and stale run', () => {
  assert.equal(classifyCi(A, []), 'UNVERIFIED_NO_RUN');
  assert.equal(classifyCi(A, [{ head_sha: B, status: 'completed', conclusion: 'success', jobs: [{ conclusion: 'success' }] }]), 'UNVERIFIED_WRONG_SHA');
  assert.equal(classifyCi(A, [{ head_sha: A, status: 'completed', conclusion: 'success', jobs: [] }]), 'UNVERIFIED_EMPTY_JOBS');
  assert.equal(classifyCi(A, [{ head_sha: A, status: 'completed', conclusion: 'action_required', jobs: [] }]), 'ACTION_REQUIRED_EMPTY_JOBS');
  assert.equal(classifyCi(A, [{ head_sha: A, status: 'in_progress', conclusion: null, jobs: [{ conclusion: null }] }]), 'PENDING');
  assert.equal(classifyCi(A, [{ head_sha: A, status: 'completed', conclusion: 'action_required', jobs: [{ conclusion: 'failure' }] }]), 'NON_GREEN');
  assert.equal(classifyCi(A, [{ head_sha: A, status: 'completed', conclusion: 'success', jobs: [{ conclusion: 'success' }] }]), 'OBSERVED_GREEN_JOBS_NOT_MERGE_APPROVAL');
});
test('report never claims merge ready and distinguishes truncated files', () => {
  const report = buildReport({ upstreamSha: A, forkSha: A, prs: [{ number: 3, title: 'sample', author: 'x', head: C, files: ['a.md'], filesComplete: false }] });
  assert.equal(report.prs[0].mergeReady, false);
  assert.equal(report.prs[0].ciJobGate, 'BLOCKED_OR_UNVERIFIED');
  const markdown = markdownReport(report);
  assert.match(markdown, /NOT_AUTHORIZED/);
  assert.match(markdown, /1\+/);
  assert.match(markdown, /NOT_CHECKED/);
  assert.match(markdown, /UNKNOWN/);
});
test('main overlap is unknown without a complete PR base-to-main comparison', () => {
  const core = { upstreamSha: A, forkSha: A };
  const p = { number: 1, head: B, filesComplete: true, files: ['doc.md'] };
  assert.equal(buildReport({ ...core, prs: [p] }).prs[0].mainPathOverlap, null);
  assert.deepEqual(buildReport({ ...core, prs: [{ ...p, mainComparisonComplete: true, mainChangedPaths: ['doc.md'] }] }).prs[0].mainPathOverlap, ['doc.md']);
});
test('action_required zero-job CI must never be merge-ready', () => {
  const report = buildReport({ upstreamSha: A, forkSha: A,
    prs: [{ number: 1, head: B, files: ['README.md'], filesComplete: true,
      ci: [{ head_sha: B, status: 'completed', conclusion: 'action_required', jobs: [] }] }] });
  assert.equal(report.prs[0].ci, 'ACTION_REQUIRED_EMPTY_JOBS');
  assert.equal(report.prs[0].ciJobGate, 'BLOCKED_OR_UNVERIFIED');
  assert.equal(report.prs[0].mergeReady, false);
});
test('live collector filters non-fork heads and performs no writes', async () => {
  const requested = [];
  const get = async path => {
    requested.push(path);
    if (path.includes('/branches/main')) return { commit: { sha: A } };
    if (path.includes('/pulls?')) return [{ number: 1, head: { sha: B, repo: { full_name: 'SinsiVinci/Nexowire-fork' } }, user: { login: 'SinsiVinci' }, base: { sha: A } }, { number: 2, head: { sha: C, repo: { full_name: 'Naveax/Nexowire' } } }];
    if (path.includes('/pulls/1/files')) return [{ filename: 'docs/readme.md' }];
    if (path.endsWith('/pulls/1')) return { number: 1, head: { sha: B }, base: { sha: A } };
    throw new Error(`Unexpected read: ${path}`);
  };
  const report = await collectSnapshot(get);
  assert.equal(report.prs.length, 1);
  assert.equal(report.prs[0].number, 1);
  assert.ok(requested.every(path => path.startsWith('/repos/')));
  assert.ok(requested.every(path => !/git\/refs|\/merges|\/comments/.test(path)));
});
test('collector rejects a PR that changes HEAD during inspection', async () => {
  const get = async path => {
    if (path.includes('/branches/main')) return { commit: { sha: A } };
    if (path.includes('/pulls?')) return [{ number: 1, head: { sha: B, repo: { full_name: 'SinsiVinci/Nexowire-fork' } }, base: { sha: A } }];
    if (path.includes('/pulls/1/files')) return [{ filename: 'a.md' }];
    if (path.endsWith('/pulls/1')) return { number: 1, head: { sha: C }, base: { sha: A } };
    throw new Error('Unexpected path');
  };
  await assert.rejects(collectSnapshot(get), /changed HEAD\/base/);
});
test('dated 23-PR exact SHA fixture preserves zero-job merge block', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../../docs/delegated/integration-k14/pr-1010-1032-rolling.json', import.meta.url), 'utf8'));
  const report = buildReport(fixture);
  assert.equal(report.prs.length, 23);
  assert.equal(report.overlaps.length, 0);
  assert.ok(report.prs.every(pr => pr.ci === 'ACTION_REQUIRED_EMPTY_JOBS' && pr.mergeReady === false));
});
