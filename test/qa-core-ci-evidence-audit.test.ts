/** #11 system QA: synthetic offline snapshots are NEVER physical CORE receipts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {auditCoreCiSnapshot} from '../scripts/qa-core-ci-evidence-audit.js';

const NAMES = [
  'test (22)', 'test (24)', 'browser-live', 'linux-native-live',
  'wsl2-live', 'security-operational-live', 'macos-agent-lifecycle-live',
] as const;

function synthetic():Record<string, unknown> {
  const sha='a'.repeat(40);
  return {
    expected:{runId:123456789,headSha:sha,workflowId:369213208},
    run:{id:123456789,head_sha:sha,workflow_id:369213208,
      status:'completed',conclusion:'success',run_attempt:1,event:'pull_request'},
    jobs:NAMES.map(name=>({name,run_id:123456789,head_sha:sha,
      status:'completed',conclusion:'success'})),
  };
}
const data=(s:Record<string,unknown>,name:'run'|'expected')=>
  s[name] as Record<string,unknown>;
const jobs=(s:Record<string,unknown>)=>s.jobs as Array<Record<string,unknown>>;

test('all seven matching CI jobs prove only snapshot consistency, not source provenance or physical CORE',()=>{
  const result=auditCoreCiSnapshot(synthetic());
  assert.equal(result.snapshotConsistency,'CONSISTENT');
  assert.deepEqual(result.findings,[]);
  assert.equal(result.githubOriginAuthenticated,false);
  assert.equal(result.physicalAcceptance,'NOT_PROVEN');
  assert.equal(result.productionCore,'NO_GO');
});
test('a prior successful SHA cannot be reused for a new PR head',()=>{
  const s=synthetic();data(s,'run').head_sha='b'.repeat(40);
  const r=auditCoreCiSnapshot(s);
  assert.equal(r.snapshotConsistency,'BLOCKED');
  assert.ok(r.findings.includes('EXACT_SHA_MISMATCH'));
});
test('partial SHA and wrongly identified workflow fail closed',()=>{
  const s=synthetic();
  data(s,'expected').headSha='43ffa6e';
  data(s,'run').workflow_id=42;
  const r=auditCoreCiSnapshot(s);
  assert.ok(r.findings.includes('EXPECTATION_INVALID'));
  assert.ok(r.findings.includes('WORKFLOW_ID_MISMATCH'));
  assert.equal(r.productionCore,'NO_GO');
});
test('a good workflow result cannot mask a missing CI job',()=>{
  const s=synthetic();s.jobs=jobs(s).slice(0,6);
  const r=auditCoreCiSnapshot(s);
  assert.ok(r.findings.includes('JOB_CARDINALITY_MISMATCH'));
  assert.ok(r.findings.includes('REQUIRED_JOB_MISSING'));
});
test('duplicate names cannot substitute for a mandatory Windows or OS job',()=>{
  const s=synthetic();jobs(s)[6]!.name='test (22)';
  const r=auditCoreCiSnapshot(s);
  assert.ok(r.findings.includes('DUPLICATE_JOB_NAME'));
  assert.ok(r.findings.includes('REQUIRED_JOB_MISSING'));
});
test('skipped, cancelled and failed jobs are not counted as successful',()=>{
  for(const conclusion of ['skipped','cancelled','failure',null]){
    const s=synthetic();jobs(s)[2]!.conclusion=conclusion;
    const r=auditCoreCiSnapshot(s);
    assert.ok(r.findings.includes('JOB_NOT_SUCCESSFUL'));
    assert.equal(r.productionCore,'NO_GO');
  }
});
test('job from another run or commit cannot be laundered into 7/7',()=>{
  const s=synthetic();jobs(s)[0]!.run_id=987; jobs(s)[1]!.head_sha='c'.repeat(40);
  const r=auditCoreCiSnapshot(s);
  assert.ok(r.findings.includes('JOB_RUN_ID_MISMATCH'));
  assert.ok(r.findings.includes('JOB_SHA_MISMATCH'));
});
test('run conclusion, attempt and event must be checked independently',()=>{
  const s=synthetic();
  data(s,'run').conclusion='failure';
  data(s,'run').run_attempt=0;
  data(s,'run').event='unknown';
  const r=auditCoreCiSnapshot(s);
  assert.ok(r.findings.includes('RUN_NOT_SUCCESSFUL'));
  assert.ok(r.findings.includes('ATTEMPT_INVALID'));
  assert.ok(r.findings.includes('EVENT_INVALID'));
});
test('forged self-reported all-green physical flags never grant production CORE',()=>{
  const s=synthetic();
  s.physicalEvidence={externalCas:true,signedPublisher:true,
    highTokenAndAcl:true,localEnrollment:true,revokeRestartSoak:true};
  s.productionReady=true;
  data(s,'run').physicallyAttested=true;
  const r=auditCoreCiSnapshot(s);
  assert.equal(r.snapshotConsistency,'CONSISTENT');
  assert.equal(r.githubOriginAuthenticated,false);
  assert.equal(r.physicalAcceptance,'NOT_PROVEN');
  assert.equal(r.productionCore,'NO_GO');
});
test('missing or malformed API payload cannot become success',()=>{
  for(const malformed of [null,undefined,{}, {run:{}},{jobs:[]},
    {expected:{runId:123,headSha:'a'.repeat(40),workflowId:1},run:{},jobs:[]}]){
    const r=auditCoreCiSnapshot(malformed);
    assert.equal(r.snapshotConsistency,'BLOCKED');
    assert.equal(r.productionCore,'NO_GO');
  }
});
test('new unknown CI jobs require deliberate matrix review, not silent PASS',()=>{
  const s=synthetic();
  jobs(s)[3]!.name='unrecognized-platform';
  const r=auditCoreCiSnapshot(s);
  assert.ok(r.findings.includes('UNEXPECTED_JOB'));
  assert.ok(r.findings.includes('REQUIRED_JOB_MISSING'));
});

test('offline green metadata and forged flags cannot prove checkout tree or Windows cases',()=>{
  const s=synthetic();
  s.checkoutRevisionEvidence='VERIFIED';
  s.checkoutTreeMatchesHead='MATCHED';
  s.windowsBrokerFixtureCases='PASSED';
  const result=auditCoreCiSnapshot(s);
  assert.equal(result.snapshotConsistency,'CONSISTENT');
  assert.equal(result.checkoutRevisionEvidence,'NOT_COLLECTED');
  assert.equal(result.checkoutTreeMatchesHead,'NOT_PROVEN');
  assert.equal(result.windowsBrokerFixtureCases,'NOT_PROVEN');
  assert.equal(result.githubOriginAuthenticated,false);
  assert.equal(result.physicalAcceptance,'NOT_PROVEN');
  assert.equal(result.productionCore,'NO_GO');
});

test('a cancelled workflow and its cancelled job cannot produce a successful snapshot',()=>{
  const s=synthetic();
  data(s,'run').conclusion='cancelled';
  jobs(s)[0]!.conclusion='cancelled';
  const result=auditCoreCiSnapshot(s);
  assert.equal(result.snapshotConsistency,'BLOCKED');
  assert.ok(result.findings.includes('RUN_NOT_SUCCESSFUL'));
  assert.ok(result.findings.includes('JOB_NOT_SUCCESSFUL'));
  assert.equal(result.physicalAcceptance,'NOT_PROVEN');
  assert.equal(result.productionCore,'NO_GO');
});
