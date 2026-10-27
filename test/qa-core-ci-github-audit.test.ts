/** #11 system QA: live-source audit tests remain synthetic and grant nothing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditCurrentGitHubCi,
  auditGitHubCiPayload,
  CORE_CI_REPOSITORY,
  CORE_CI_WORKFLOW_ID,
  REQUIRED_CORE_CI_JOBS,
} from '../scripts/qa-core-ci-github-audit.js';

const headSha='a'.repeat(40);
const baseSha='b'.repeat(40);
const runId=40500012345;
const prNumber=912;
const repo=CORE_CI_REPOSITORY;
const token='ghp_test_token_never_logged_or_transmitted';

function fixtures(){
  const pullRequest={
    number:prNumber,state:'open',draft:true,
    head:{
      ref:'qa/11-test-branch',sha:headSha,
      repo:{full_name:repo},
    },
    base:{
      ref:'main',sha:baseSha,
      repo:{full_name:repo},
    },
  };
  const run={
    id:runId,head_branch:'qa/11-test-branch',head_sha:headSha,
    head_repository:{full_name:repo},
    workflow_id:CORE_CI_WORKFLOW_ID,status:'completed',conclusion:'success',
    run_attempt:1,event:'pull_request',
    pull_requests:[{
      number:prNumber,
      head:{sha:headSha,ref:'qa/11-test-branch'},
      base:{sha:baseSha,ref:'main'},
    }],
  };
  const jobs={
    total_count:REQUIRED_CORE_CI_JOBS.length,
    jobs:REQUIRED_CORE_CI_JOBS.map(name=>({
      name,run_id:runId,run_attempt:1,status:'completed',conclusion:'success',
    })),
  };
  return {pullRequest,run,jobs};
}

function fakeFetch(responses:unknown[]){
  let cursor=0;
  const urls:string[]=[];
  const authHeaders:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=typeof input==='string'?input:
      input instanceof URL?input.href:input.url;
    urls.push(url);
    authHeaders.push(new Headers(init?.headers).get('authorization')??'');
    const body=responses[cursor++];
    if(body===undefined)throw new Error('Unexpected request');
    return new Response(JSON.stringify(body),{
      status:200,headers:{'content-type':'application/json'},
    });
  };
  return {fetcher,urls,authHeaders};
}

function auditInput(){
  return {
    repositoryFullName:repo,pullRequestNumber:prNumber,runId,token,
  };
}

test('live audit binds authenticated source, exact PR, run attempt and complete jobs',async()=>{
  const fixture=fixtures();
  const fake=fakeFetch([
    {login:'synthetic-test-user',id:1},
    fixture.pullRequest,fixture.run,fixture.jobs,fixture.pullRequest,
  ]);
  const report=await auditCurrentGitHubCi(auditInput(),fake.fetcher);
  assert.equal(report.snapshotConsistency,'CONSISTENT');
  assert.equal(report.headSha,headSha);
  assert.equal(report.baseSha,baseSha);
  assert.equal(report.runAttempt,1);
  assert.equal(report.githubOriginAuthenticated,false);
  assert.equal(report.physicalAcceptance,'NOT_PROVEN');
  assert.equal(report.productionCore,'NO_GO');
  assert.equal(fake.urls.length,5);
  assert.equal(fake.urls[0],'https://api.github.com/user');
  assert.ok(fake.urls.every(url=>url.startsWith('https://api.github.com/')));
  assert.ok(fake.authHeaders.every(value=>value==='Bearer '+token));
  assert.equal(JSON.stringify(report).includes(token),false);
});

test('saved or mismatched SHA cannot inherit a current PASS',async()=>{
  const fixture=fixtures();
  fixture.run.head_sha='c'.repeat(40);
  const fake=fakeFetch([
    {login:'synthetic-test-user',id:1},
    fixture.pullRequest,fixture.run,fixture.jobs,fixture.pullRequest,
  ]);
  const report=await auditCurrentGitHubCi(auditInput(),fake.fetcher);
  assert.equal(report.snapshotConsistency,'BLOCKED');
  assert.ok(report.findings.includes('EXACT_SHA_MISMATCH'));
  assert.equal(report.productionCore,'NO_GO');
});

test('the workflow must be the pinned CI workflow',async()=>{
  const fixture=fixtures();
  fixture.run.workflow_id=17;
  const fake=fakeFetch([
    {login:'synthetic-test-user',id:1},
    fixture.pullRequest,fixture.run,fixture.jobs,fixture.pullRequest,
  ]);
  const report=await auditCurrentGitHubCi(auditInput(),fake.fetcher);
  assert.ok(report.findings.includes('WORKFLOW_ID_MISMATCH'));
});

test('base movement after the run blocks exact PR context',async()=>{
  const fixture=fixtures();
  fixture.pullRequest.base.sha='d'.repeat(40);
  const fake=fakeFetch([
    {login:'synthetic-test-user',id:1},
    fixture.pullRequest,fixture.run,fixture.jobs,fixture.pullRequest,
  ]);
  const report=await auditCurrentGitHubCi(auditInput(),fake.fetcher);
  assert.ok(report.findings.includes('RUN_PR_BASE_MISMATCH'));
  assert.equal(report.snapshotConsistency,'BLOCKED');
});

test('PR head or base changing during the audit invalidates the snapshot',async()=>{
  const fixture=fixtures();
  const changed={...fixture.pullRequest,head:{
    ...fixture.pullRequest.head,sha:'e'.repeat(40),
  }};
  const fake=fakeFetch([
    {login:'synthetic-test-user',id:1},
    fixture.pullRequest,fixture.run,fixture.jobs,changed,
  ]);
  const report=await auditCurrentGitHubCi(auditInput(),fake.fetcher);
  assert.ok(report.findings.includes('PR_CHANGED_DURING_AUDIT'));
});

test('workflow_dispatch must resolve its exact commit to the current PR',async()=>{
  const fixture=fixtures();
  fixture.run.event='workflow_dispatch';
  fixture.run.pull_requests=[];
  const fake=fakeFetch([
    {login:'synthetic-test-user',id:1},
    fixture.pullRequest,fixture.run,fixture.jobs,fixture.pullRequest,
    [fixture.pullRequest],
  ]);
  const report=await auditCurrentGitHubCi(auditInput(),fake.fetcher);
  assert.equal(report.snapshotConsistency,'CONSISTENT');
  assert.equal(report.event,'workflow_dispatch');
  assert.ok(fake.urls.some(url=>url.includes('/commits/'+headSha+'/pulls?')));
  assert.equal(report.githubOriginAuthenticated,false);
});

test('foreign PR context cannot be reused for another pull request',async()=>{
  const fixture=fixtures();
  fixture.run.pull_requests[0]!.number=913;
  const fake=fakeFetch([
    {login:'synthetic-test-user',id:1},
    fixture.pullRequest,fixture.run,fixture.jobs,fixture.pullRequest,
  ]);
  const report=await auditCurrentGitHubCi(auditInput(),fake.fetcher);
  assert.ok(report.findings.includes('RUN_PR_CONTEXT_MISSING'));
});

test('duplicate, missing, skipped, failed and foreign-run jobs block evidence',()=>{
  const fixture=fixtures();
  const jobs=fixture.jobs.jobs as Array<{
    name:string;run_id:number;run_attempt:number;status:string;conclusion:string;
  }>;
  jobs[0]!.name=jobs[1]!.name;
  jobs[2]!.conclusion='skipped';
  jobs[3]!.run_id=9;
  jobs[4]!.name='unexpected';
  const report=auditGitHubCiPayload({
    repositoryFullName:repo,pullRequestNumber:prNumber,runId,
    pullRequest:fixture.pullRequest,
    recheckedPullRequest:fixture.pullRequest,
    run:fixture.run,jobs:fixture.jobs,
  });
  assert.ok(report.findings.includes('DUPLICATE_JOB_NAME'));
  assert.ok(report.findings.includes('JOB_NOT_SUCCESSFUL'));
  assert.ok(report.findings.includes('JOB_RUN_ID_MISMATCH'));
  assert.ok(report.findings.includes('UNEXPECTED_JOB'));
  assert.equal(report.productionCore,'NO_GO');
});

test('job pagination truncation and attempt mismatch block evidence',()=>{
  const fixture=fixtures();
  (fixture.jobs as {total_count:number}).total_count=8;
  fixture.jobs.jobs[0]!.run_attempt=2;
  const report=auditGitHubCiPayload({
    repositoryFullName:repo,pullRequestNumber:prNumber,runId,
    pullRequest:fixture.pullRequest,
    recheckedPullRequest:fixture.pullRequest,
    run:fixture.run,jobs:fixture.jobs,
  });
  assert.ok(report.findings.includes('JOB_PAGE_INCOMPLETE'));
  assert.ok(report.findings.includes('JOB_ATTEMPT_MISMATCH'));
});

test('invalid token and foreign repository are rejected before any request',async()=>{
  const fake=fakeFetch([]);
  await assert.rejects(()=>auditCurrentGitHubCi({
    ...auditInput(),token:'bad',
  },fake.fetcher),/GITHUB_TOKEN_REQUIRED_OR_INVALID/);
  await assert.rejects(()=>auditCurrentGitHubCi({
    ...auditInput(),repositoryFullName:'attacker/Nexowire',
  },fake.fetcher),/GITHUB_CI_INPUT_INVALID/);
  assert.equal(fake.urls.length,0);
});

test('attempt-scoped job endpoint remains usable when job records omit run_attempt',async()=>{
  const fixture=fixtures();
  for(const job of fixture.jobs.jobs){
    delete (job as {run_attempt?:number}).run_attempt;
  }
  const fake=fakeFetch([
    {login:'synthetic-test-user',id:1},
    fixture.pullRequest,fixture.run,fixture.jobs,fixture.pullRequest,
  ]);
  const report=await auditCurrentGitHubCi(auditInput(),fake.fetcher);
  assert.equal(report.snapshotConsistency,'CONSISTENT');
  assert.ok(fake.urls.some(url=>url.includes('/attempts/1/jobs?')));
});

test('a token response without authenticated user identity is rejected',async()=>{
  const fixture=fixtures();
  const fake=fakeFetch([
    {message:'not authenticated'},
    fixture.pullRequest,fixture.run,fixture.jobs,fixture.pullRequest,
  ]);
  await assert.rejects(
    ()=>auditCurrentGitHubCi(auditInput(),fake.fetcher),
    /GITHUB_TOKEN_AUTHENTICATION_FAILED/,
  );
});

test('malformed caller-supplied records never become authenticated or accepted',()=>{
  const report=auditGitHubCiPayload(null);
  assert.equal(report.snapshotConsistency,'BLOCKED');
  assert.equal(report.githubOriginAuthenticated,false);
  assert.equal(report.physicalAcceptance,'NOT_PROVEN');
  assert.equal(report.productionCore,'NO_GO');
});
