#!/usr/bin/env node
/** P008: two-snapshot CI provenance + WSL2 stage triage. No external writes. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { EXPECTED_PR_NUMBERS, ciGate59, validateSnapshot } from './p007-59-pr-gates.mjs';

const SHA=/^[a-f0-9]{40}$/i;
function requireCondition(value, why) { if (!value) throw Error(why); }

export function stageTriage(failed, control) {
  for (const [name, r] of [['failed', failed], ['control', control]]) {
    requireCondition(Number.isSafeInteger(r?.jobId) && Number.isSafeInteger(r.runId) &&
      SHA.test(r.prHead ?? '') && r.prHead === r.runHead &&
      Array.isArray(r.steps) && r.steps.length >= 5, `${name} WSL provenance incomplete`);
  }
  const installName='Install real Ubuntu WSL2 distro';
  const bad=failed.steps.find(x=>x.name===installName);
  const good=control.steps.find(x=>x.name===installName);
  requireCondition(bad && good && failed.conclusion==='failure' && control.conclusion==='success', 'WSL control pairing inconsistent');
  const before=failed.steps.slice(0,3).every(s=>s.conclusion==='success');
  const later=failed.steps.filter(s=>['Run npm ci','Run npm run typecheck','Verify Nexowire wsl.exec against real WSL2'].includes(s.name));
  const duration=(Date.parse(failed.completed_at)-Date.parse(failed.started_at))/1000;
  const goodInstall=(Date.parse(good.completed_at)-Date.parse(good.started_at))/1000;
  const wholeGood=(Date.parse(control.completed_at)-Date.parse(control.started_at))/1000;
  requireCondition([duration,goodInstall,wholeGood].every(n=>Number.isFinite(n)&&n>=0), 'WSL timing invalid');
  return {
    failedRun:failed.runId, failedJob:failed.jobId, failedHead:failed.prHead,
    controlRun:control.runId, controlJob:control.jobId, controlHead:control.prHead,
    failedDurationSeconds:duration, controlInstallSeconds:goodInstall, controlDurationSeconds:wholeGood,
    firstThreeStepsSuccess:before,
    failedInstallStepState:bad.status,
    failedInstallStepConclusion:bad.conclusion,
    downstreamWereNotRun:later.length===3&&later.every(s=>s.status==='pending'&&s.conclusion===null),
    directRootCauseLogAvailable:typeof failed.jobLog==='string' && failed.jobLog.length>0 && failed.jobLog!=='404_BlobNotFound' && failed.jobLog!=='NOT_RUN',
    artifactCount:failed.artifactCount,
    inference:before && bad.status==='in_progress' && bad.conclusion===null && later.length===3 && later.every(s=>s.status==='pending'&&s.conclusion===null)
      ? 'WSL_DISTRO_INSTALL_STAGE_HUNG_OR_TIMED_OUT_CAUSE_NOT_PROVEN' : 'WSL_FAILURE_STAGE_UNKNOWN',
    bugInNexowireSourceProven:false,
  };
}

export function auditDelta(previous, current) {
  validateSnapshot(previous);
  requireCondition(current?.previousFixture==='p007-59-prs-20261108.json' &&
    SHA.test(current.main ?? '') && current.main===current.forkMain &&
    SHA.test(current.owner1096Head ?? ''), 'P008 upstream/owner provenance incomplete');
  requireCondition(Number.isFinite(Date.parse(current.capturedAt))&&
    Date.parse(current.capturedAt)>=Date.parse(previous.capturedAt), 'snapshot chronology invalid');
  requireCondition(Array.isArray(current.prs)&&current.prs.length===EXPECTED_PR_NUMBERS.length, 'P008 missing 59 PRs');
  const original=new Map(previous.prs.map(x=>[x.number,x]));
  const seen=new Set(), rows=[];
  for(const item of current.prs) {
    const p=original.get(item.number);
    requireCondition(p && !seen.has(item.number),'P008 duplicate/unknown source PR');
    seen.add(item.number);
    requireCondition(item.state==='open'&&item.draft===true&&
      [item.head,item.previousHead,item.base].every(s=>SHA.test(s??''))&&
      item.previousHead===p.head,'P008 source PR state or previous HEAD mismatch');
    requireCondition(Number.isSafeInteger(item.run?.id)&&item.run.head_sha===item.head,
      `#${item.number} exact-head run missing`);
    const oldValid=p.head===item.head&&p.run?.id===item.run.id&&
      p.run?.head_sha===item.head&&Array.isArray(p.jobs);
    const jobSource=item.updatedJobs??(oldValid?{runId:p.run.id,total:p.totalJobs,jobs:p.jobs}:null);
    requireCondition(jobSource&&jobSource.runId===item.run.id&&
      Number.isSafeInteger(jobSource.total)&&Array.isArray(jobSource.jobs),
    `#${item.number} jobs must match latest exact-head run`);
    const computed=ciGate59({head:item.head,firstHead:item.head,run:item.run,
      totalJobs:jobSource.total,jobs:jobSource.jobs});
    rows.push({number:item.number,firstHead:p.head,head:item.head,changedHead:p.head!==item.head,
      runId:item.run.id,runStatus:item.run.status,runConclusion:item.run.conclusion,
      jobSource:item.updatedJobs?'NEW_RUN_JOBS':'PRIOR_VERIFIED_SAME_RUN',ci:computed,
      ownerApproval:'PENDING',mergeAuthorized:false,newNestedTestHostedProof:'NOT_VERIFIED'});
  }
  const groups={};for(const row of rows)(groups[row.ci]??=[]).push(row.number);
  return {capturedAt:current.capturedAt,upstreamMain:current.main,owner1096Head:current.owner1096Head,
    scannedPrs:rows.length,sourceHEADChanges:rows.filter(r=>r.changedHead).map(r=>r.number),
    jobRefreshCount:rows.filter(r=>r.jobSource==='NEW_RUN_JOBS').length,
    groups,rows:rows.sort((a,b)=>a.number-b.number),wsl:stageTriage(current.wslInvestigation.failed,current.wslInvestigation.control),
    metadataAfterMovingHeads:'NOT_RESCANNED',physicalAcceptance:'NOT_RUN',
    newNestedTestHostedProof:'NOT_VERIFIED',mergeAuthorized:false};
}

export function markdownDelta(previous,current) {
  const r=auditDelta(previous,current);
  return [
    '# P008 — 59 PR exact SHA/CI drift and WSL2 failure stage', '',
    `Capture ${r.capturedAt}; main=${r.upstreamMain}; owner CORE #1096=${r.owner1096Head}.`,
    `PRs ${r.scannedPrs}; changed HEAD since P007=${r.sourceHEADChanges.join(',')}; new job pages=${r.jobRefreshCount}.`,
    `Latest exact-head status counts=${JSON.stringify(Object.fromEntries(Object.entries(r.groups).map(([k,v])=>[k,v.length])))}.`,
    `#1120 WSL run ${r.wsl.failedRun}, job ${r.wsl.failedJob}: ${r.wsl.failedDurationSeconds}s; install-step ${r.wsl.failedInstallStepState}; following steps NOT_RUN=${r.wsl.downstreamWereNotRun}.`,
    `#1153 WSL control run ${r.wsl.controlRun}: install ${r.wsl.controlInstallSeconds}s and job ${r.wsl.controlDurationSeconds}s.`,
    `Job logs directly readable=${r.wsl.directRootCauseLogAvailable}; artifacts=${r.wsl.artifactCount}; inference=${r.wsl.inference}.`,
    'No source bug proven, new nested MJS hosted execution NOT_VERIFIED, physical acceptance NOT_RUN; NO MERGE.', '',
    '| PR | Exact new HEAD | Latest run | CI source conclusion | Moved since P007 |',
    '| --- | --- | --- | --- | --- |',
    ...r.rows.map(p=>`| #${p.number} | ${p.head.slice(0,12)} | ${p.runId} | ${p.ci} | ${p.changedHead} |`),
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const i=process.argv.indexOf('--previous'),j=process.argv.indexOf('--current');
  if(i<0||j<0||!process.argv[i+1]||!process.argv[j+1])throw Error('Usage: --previous p007.json --current p008.json [--json]');
  Promise.all([readFile(process.argv[i+1],'utf8'),readFile(process.argv[j+1],'utf8')]).then(v=>v.map(JSON.parse)).then(([a,b])=>
    process.stdout.write(process.argv.includes('--json')?JSON.stringify(auditDelta(a,b),null,2)+'\n':markdownDelta(a,b))
  ).catch(e=>{console.error(e.message);process.exitCode=1;});
}
