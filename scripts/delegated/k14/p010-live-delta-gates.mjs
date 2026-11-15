#!/usr/bin/env node
/** Offline read-only integration evidence gate: no network, CI dispatch, or merges. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const SHA=/^[a-f0-9]{40}$/i;
function must(ok, message) { if (!ok) throw Error(message); }
const unique=xs=>new Set(xs).size===xs.length;

export function auditLiveDelta(previous, current) {
  must(Array.isArray(previous?.prs)&&previous.prs.length===59, 'baseline 59 PRs missing');
  must(Number.isFinite(Date.parse(previous.capturedAt)), 'baseline timestamp missing');
  must(Number.isFinite(Date.parse(current?.capturedAt))&&Date.parse(current.capturedAt)>=Date.parse(previous.capturedAt), 'capture chronology invalid');
  must(SHA.test(current.main??'')&&current.main===current.forkMain, 'main/fork mismatch');
  must(Array.isArray(current.prs)&&current.prs.length===59, 'current 59 PRs missing');
  const prev=new Map(previous.prs.map(p=>[p.number,p]));
  must(prev.size===59, 'duplicate baseline PR');
  const seen=new Set(), changed=[];
  for(const pr of current.prs) {
    must(Number.isSafeInteger(pr.number)&&prev.has(pr.number)&&!seen.has(pr.number), 'unknown or duplicate current PR');
    must(pr.state==='open'&&pr.draft===true&&SHA.test(pr.head??''), `#${pr.number} not pinned open Draft`);
    seen.add(pr.number);
    if(prev.get(pr.number).head!==pr.head) changed.push(pr.number);
  }
  for (const n of [1068,1096,1160]) {
    const owner=current.owners?.[n];
    must(SHA.test(owner?.head??'')&&Array.isArray(owner.paths)&&owner.paths.length>0&&
      owner.paths.every(p=>typeof p==='string'&&p.length>0)&&unique(owner.paths), `owner #${n} changed-path evidence missing`);
  }
  must(current.k14?.number===1153&&SHA.test(current.k14.head??'')&&
    Array.isArray(current.k14.paths)&&current.k14.paths.length>0&&unique(current.k14.paths), 'K14 exact changed paths missing');
  must(current.k14.head===current.prs.find(p=>p.number===1153).head, 'K14 changed path HEAD drift');
  const ownerCollisions={};
  for(const n of [1068,1096,1160]) {
    const ownerPaths=new Set(current.owners[n].paths);
    ownerCollisions[n]=current.k14.paths.filter(p=>ownerPaths.has(p));
  }
  const currentMap=new Map(current.prs.map(p=>[p.number,p]));
  must(Array.isArray(current.runObservations), 'exact run observations missing');
  const checked=new Set(), runs=[];
  for(const item of current.runObservations) {
    must(currentMap.has(item.number)&&!checked.has(item.number), 'unknown or duplicate run observation');
    checked.add(item.number);
    must(item.head===currentMap.get(item.number).head, `#${item.number} stale run HEAD`);
    must((Number.isSafeInteger(item.runId)&&item.runId>0&&item.status==='completed'&&
       ['success','failure','cancelled','action_required'].includes(item.conclusion)) ||
      (Number.isSafeInteger(item.runId)&&item.runId>0&&['queued','in_progress'].includes(item.status)&&item.conclusion===null) ||
      (item.runId===null&&item.status==='NO_RUN_OBSERVED'&&item.conclusion===null), `#${item.number} invalid run observation`);
    runs.push({number:item.number,head:item.head,runId:item.runId,status:item.status,conclusion:item.conclusion,
      actualNestedTestInvocation:'NOT_VERIFIED_BY_WORKFLOW_STATUS',mergeAuthorized:false});
  }
  const overlapCount=Object.values(ownerCollisions).reduce((a,x)=>a+x.length,0);
  return {
    capturedAt:current.capturedAt, baselineAt:previous.capturedAt, main:current.main,
    scanned:current.prs.length, changed:changed.sort((a,b)=>a-b), unchanged:current.prs.length-changed.length,
    ownerHeads:Object.fromEntries([1068,1096,1160].map(n=>[n,current.owners[n].head])),
    ownerPathCounts:Object.fromEntries([1068,1096,1160].map(n=>[n,current.owners[n].paths.length])),
    ownerCollisions,k14ChangedPaths:current.k14.paths.length,
    runs,runsChecked:runs.length,ciCoverageComplete:runs.length===59,
    hasSourceOverlaps:overlapCount>0,
    metadataRescan:'NOT_PROVEN',nestedExecution:'NOT_VERIFIED',physicalAcceptance:'NOT_RUN',
    ownerApproval:'PENDING',mergeAuthorized:false,historicalRollingSnapshot:true,
  };
}

export function markdownLiveDelta(previous,current) {
  const r=auditLiveDelta(previous,current);
  return [
    '# K14 P010 rolling integration QA (read-only)', '',
    `Captured ${r.capturedAt}; baseline ${r.baselineAt}; main ${r.main}.`,
    `Open Draft ${r.scanned}; SHA moved ${r.changed.length}: ${r.changed.join(',')}; unchanged ${r.unchanged}.`,
    `Owner path counts ${JSON.stringify(r.ownerPathCounts)}; owner overlaps ${JSON.stringify(r.ownerCollisions)}.`,
    `Exact-HEAD workflow statuses observed for ${r.runsChecked}/${r.scanned}; this is not 59/59 job verification.`,
    'Successful workflow status does not prove nested tests or physical acceptance. No owner authorization or merge.', '',
    '| PR | Exact SHA | run ID | workflow status |', '| --- | --- | --- | --- |',
    ...r.runs.map(x=>`| #${x.number} | ${x.head.slice(0,12)} | ${x.runId??'NONE'} | ${x.status}/${x.conclusion??'PENDING'} |`), '',
  ].join('\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const a=process.argv.indexOf('--previous'),b=process.argv.indexOf('--current');
  if(a<0||b<0||!process.argv[a+1]||!process.argv[b+1]) throw Error('Usage: --previous prior.json --current now.json');
  Promise.all([readFile(process.argv[a+1],'utf8'),readFile(process.argv[b+1],'utf8')]).then(v=>v.map(JSON.parse))
    .then(([old,now])=>process.stdout.write(markdownLiveDelta(old,now)))
    .catch(e=>{console.error(e.message);process.exitCode=1;});
}
