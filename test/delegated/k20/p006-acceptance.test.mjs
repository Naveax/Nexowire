import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditFixedCountGate, findClosingKeywords, auditIssueLifecycle,
  auditHostedAcceptance } from '../../../scripts/delegated/k20/p006-ci-issue-gate.mjs';
import { auditP006Board, auditPrCohort, auditCrossWorkerPoolClaims } from
  '../../../scripts/delegated/k20/p006-board-pr-audit.mjs';

const snapshot = JSON.parse(readFileSync(
  new URL('../../../docs/delegated/maintenance-k20/P006_EVIDENCE_SNAPSHOT_20261108.json', import.meta.url)));
const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const tap = n => `# tests ${n}\n# pass ${n}\n# fail 0\n# skipped 0\n# todo 0\n`;
const prior = { head: snapshot.upstreamMain, runHead: snapshot.upstreamMain,
  workflow, expectedFile: 'nw-k20-qa.tap', conclusion: 'failure' };

test('T-649: #1118/#1130/#1141 live RED counts 50/48/52 disagree with protected fixed 41', () => {
  for (const run of snapshot.runs) {
    const audited = auditFixedCountGate({ ...prior, tap: tap(run.tapTests), runId: run.runId });
    assert.equal(audited.verdict, 'COUNT_DRIFT_REPRODUCED', String(run.pr));
    assert.equal(audited.pinned.tests[0], 41);
    assert.equal(audited.pinned.pass[0], 41);
    assert.equal(audited.assertionsGreen, true);
    assert.equal(audited.accepted, false);
  }
});

test('T-649: matching baseline 41 is green assertions only; stale/head incomplete remains no acceptance', () => {
  assert.equal(auditFixedCountGate({ ...prior, tap: tap(41), runId: 42474379692 }).verdict,
    'NO_COUNT_DRIFT_PROVEN');
  const mismatch = auditFixedCountGate({ ...prior, runHead: 'a'.repeat(40),
    tap: tap(52), runId: 42474379692 });
  assert.equal(mismatch.verdict, 'STALE_HEAD');
  assert.equal(auditFixedCountGate({ ...prior, tap: 'broken', runId: 42474379692 }).verdict,
    'UNKNOWN_TAP');
  assert.equal(auditFixedCountGate({ ...prior, tap: '# tests 2\n# pass 1\n# fail 1\n# skipped 0\n# todo 0\n',
    runId: 42474379692 }).verdict, 'ASSERTIONS_RED');
  assert.equal(auditFixedCountGate({ ...prior, tap: tap(52).split('\n').map(s => s && `2026-11-08T11:14:36.00Z ${s}`).join('\n'),
    runId: 42474379692 }).verdict, 'COUNT_DRIFT_REPRODUCED');
});

const fixtureBoard = () => [
  '# NEXOWIRE EKİP PANOSU — P006',
  '- P005 T-395…T-514: **92/120 (%76,7) kaynak/yerel QA teslim**, 28 kısmi.',
  ...Object.entries(snapshot.p006.workers).flatMap(([worker, tasks]) => [
    `### ${worker} — source-only`,
    `- **AKTİF T-${tasks[0]}:** #1006 audit.`,
    ...tasks.slice(1).map((id, i) => `  ${i+1}. **T-${id}:** #1006 audit.`),
  ]),
  '## HAVUZ — SAHİPSİZ',
].join('\n');

test('T-650: P006 ledger has 20 workers and 120 distinct T-535..654, P005 92/28 separately', () => {
  const r = auditP006Board(fixtureBoard());
  assert.equal(r.valid, true);
  assert.equal(r.workers, 20);
  assert.equal(r.uniqueTasks, 120);
  assert.equal(r.priorCompletedReported, 92);
  assert.equal(r.priorOpenReported, 28);
  assert.equal(r.priorCreditIndependentlyVerified, false);
});

test('T-650: duplicate/missing T-ID and inflated old credit fail closed', () => {
  const board = fixtureBoard();
  const duplicate = auditP006Board(board.replace('**T-654:**', '**T-653:**'));
  assert.equal(duplicate.valid, false);
  assert.deepEqual(duplicate.missing, [654]);
  assert.deepEqual(duplicate.duplicates.map(x => x.task), [653]);
  assert.equal(auditP006Board(board.replace('**92/120', '**93/120')).valid, false);
});

test('T-650: 20 live worker status claims have one historical double-claim T385; K02 alone gets credit', () => {
  const files = Object.entries(snapshot.claimsByWorker).map(([worker, ids]) => ({
    worker, text: ids.map(n => `ÜSTLENDİM: T-${n}`).join('\n'),
  }));
  const result = auditCrossWorkerPoolClaims(files);
  assert.equal(result.workersScanned, 20);
  assert.equal(result.duplicateCreditAfterTieBreak, 0);
  assert.deepEqual(result.shared, [{task:385,creditedTo:'K02',noCredit:['K16']}]);
  assert.equal(result.creditVerifiedByStatusTextOnly,true);
  assert.throws(() => auditCrossWorkerPoolClaims([files[0],files[0]]),/duplicate/i);
});

test('T-651: negated cannot close #487 is a real auto-close marker, neutral wording is not', () => {
  assert.deepEqual(findClosingKeywords('We cannot close #487 until physical acceptance'),
    [{ issue: 487, phrase: 'close #487' }]);
  assert.deepEqual(findClosingKeywords('Acceptance for issue #487 remains OPEN'), []);
  assert.deepEqual(findClosingKeywords('Fixes #540, resolved #487 and closed #539').map(x=>x.issue),
    [540,487,539]);
});

test('T-651: merged #1135 and transient issue closure do not mean #487 is resolved', () => {
  const state = auditIssueLifecycle({ issue: { number: 487, state: snapshot.issue487.state },
    pr: { number: 1135, merged: true, title: 'fix(ops): positive sub-cent projection',
      body: 'Acceptance for issue #487 remains OPEN' },
    transitions: ['opened', 'closed', 'reopened'],
  });
  assert.equal(state.closedThenReopened, true);
  assert.equal(state.state, 'OPEN');
  assert.equal(state.resolved, false);
  assert.equal(state.risk, 'NO_MARKER_DETECTED');
  assert.equal(auditIssueLifecycle({issue:{number:487,state:'closed'},
    pr:{number:1135,merged:true,body:'cannot close #487'},transitions:['closed']}).resolved,false);
});

test('T-652: source 44 PR heads contain exactly 42 Draft, 2 merged, no page gap', () => {
  const r = auditPrCohort(snapshot.prs);
  assert.equal(r.complete, true);
  assert.equal(r.observed, 44);
  assert.equal(r.draft, 42);
  assert.deepEqual(r.merged, [1102,1135]);
  assert.deepEqual(r.missing, []);
  assert.equal(r.issueAcceptanceInferred, false);
});

test('T-652: incomplete/duplicated PR page, missing SHA or unexpected lifecycle rejects count', () => {
  assert.deepEqual(auditPrCohort(snapshot.prs.slice(0,-1)).missing, [1142]);
  assert.throws(() => auditPrCohort([...snapshot.prs, snapshot.prs[0]]), /duplicate/i);
  assert.throws(() => auditPrCohort(snapshot.prs.map(x =>
    x.number === 1141 ? {...x,head_sha:'not-sha'} : x)), /invalid/i);
  const notDraft = auditPrCohort(snapshot.prs.map(x =>
    x.number === 1141 ? {...x,draft:false} : x));
  assert.deepEqual(notDraft.irregular,[1141]);
  assert.equal(notDraft.complete,false);
});

const SHA = snapshot.upstreamMain;
const jobs = Array.from({length:7}, (_,i) => ({id:i+1, status:'completed',conclusion:'success'}));
const goodRun = {id:42474379692,headSha:SHA,status:'completed',conclusion:'success'};
const nested = [{path:'test/delegated/k20/p006-acceptance.test.mjs',marker:'T-653: hosted proof sentinel'}];

test('T-653: all 7 jobs green with zero newly-executed test markers never passes gate', () => {
  const s = auditHostedAcceptance({head:SHA,run:goodRun,jobs,newTests:nested});
  assert.equal(s.ci,'REPORTED_ALL_GREEN');
  assert.equal(s.discovery,'NOT_VERIFIED');
  assert.deepEqual(s.missingTestPaths,nested.map(x=>x.path));
  assert.equal(s.accepted,false);
});

test('T-653: actual CLI rejects false-green snapshot with nonzero process exit', () => {
  const cli = fileURLToPath(new URL('../../../scripts/delegated/k20/p006-ci-issue-gate.mjs', import.meta.url));
  const input = fileURLToPath(new URL('./fixtures/p006-seven-green-no-discovery.json', import.meta.url));
  const proc = spawnSync(process.execPath, [cli, '--input', input], {encoding:'utf8',timeout:5000});
  assert.equal(proc.error, undefined);
  assert.equal(proc.status, 1);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.ci, 'REPORTED_ALL_GREEN');
  assert.equal(result.discovery, 'NOT_VERIFIED');
  assert.equal(result.accepted, false);
});

test('T-653: explicit path and runner output marker are required; 7/7 is not physical proof', () => {
  const log = `node --test ${nested[0].path}\n# Subtest: T-653: hosted proof sentinel\nok 1`;
  const s = auditHostedAcceptance({head:SHA,run:{...goodRun,log},jobs,newTests:nested});
  assert.equal(s.discovery,'REPORTED_LOG_PATH_AND_MARKER');
  assert.equal(s.physical,'NOT_RUN_OR_NOT_VERIFIED');
  assert.equal(s.accepted,false);
  assert.equal(auditHostedAcceptance({head:SHA,run:{...goodRun,log:'path absent'},jobs,newTests:[]}).discovery,
    'NOT_VERIFIED');
});

test('T-654: stale exact HEAD, empty jobs and failed jobs cannot inherit green acceptance', () => {
  assert.equal(auditHostedAcceptance({head:SHA,run:{...goodRun,headSha:'a'.repeat(40)},jobs,newTests:nested}).ci,
    'STALE_OR_UNKNOWN_HEAD');
  assert.equal(auditHostedAcceptance({head:SHA,run:goodRun,jobs:[],newTests:nested}).ci,
    'JOBS_MISSING');
  assert.equal(auditHostedAcceptance({head:SHA,run:{...goodRun,totalJobs:8},jobs,newTests:nested}).ci,
    'JOBS_MISSING');
  assert.equal(auditHostedAcceptance({head:SHA,run:goodRun,
    jobs:[...jobs.slice(0,6),{id:7,status:'completed',conclusion:'failure'}],newTests:nested}).ci,
    'CI_NOT_GREEN');
  assert.equal(auditHostedAcceptance({head:SHA,run:null,newTests:nested}).ci,'NOT_RUN');
});

test('T-654: declared physical PASS is not silently assumed; installed SHA mismatch stays NOT_RUN', () => {
  const physical = {environment:'physical-windows',status:'PASS',installedBuildSha:'a'.repeat(40),evidenceId:'test-device'};
  assert.equal(auditHostedAcceptance({head:SHA,run:goodRun,jobs,newTests:nested,physical}).physical,
    'NOT_RUN_OR_NOT_VERIFIED');
  assert.equal(auditHostedAcceptance({head:SHA,run:goodRun,jobs,newTests:nested,
    physical:{...physical,installedBuildSha:SHA}}).physical,
    'PHYSICAL_PROOF_REPORTED_NEEDS_REVIEW');
  assert.equal(auditHostedAcceptance({head:SHA,run:goodRun,jobs,newTests:nested,
    physical:{...physical,installedBuildSha:SHA}}).accepted,false);
});
