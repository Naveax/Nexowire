/**
 * 24-hour acceptance evidence gate. Never starts traffic. A partial duration
 * cannot pass even if every latency sample looks good.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export interface SoakEvidence{
  sourceCommit:string;environment:'authorized-staging';
  startedAtUtc:string;endedAtUtc:string;
  samples:Array<{atUtc:string;connections:number;rpcCompleted:number;
    p99Ms:number;errorFraction:number;cpuPercent:number;rssBytes:number}>;
  providerCountersVerified:boolean;
  executionCompletionCountersVerified:boolean;
  ownerApprovalRecorded:boolean;
  outageOrSpendingIncident:boolean;
}
export function acceptSoak(e:SoakEvidence){
  const durationMs=Date.parse(e.endedAtUtc)-Date.parse(e.startedAtUtc);
  const reasons:string[]=[];
  if(e.environment!=='authorized-staging')reasons.push('not authorized staging');
  if(!/^[a-f0-9]{40}$/.test(e.sourceCommit))reasons.push('unverified source SHA');
  if(!Number.isFinite(durationMs)||durationMs<86400000)reasons.push('less than 24 hours elapsed');
  if(!e.ownerApprovalRecorded)reasons.push('missing owner staging approval');
  if(!e.providerCountersVerified)reasons.push('no real provider usage counters');
  if(!e.executionCompletionCountersVerified)reasons.push('no actual completed RPC proof');
  if(e.outageOrSpendingIncident)reasons.push('incident during soak');
  if(!Array.isArray(e.samples)||e.samples.length<1440)reasons.push('missing minute interval samples');
  else {
    for(const s of e.samples){
      if(!Number.isFinite(Date.parse(s.atUtc))||!Number.isFinite(s.connections)||
        !Number.isFinite(s.rpcCompleted)||!Number.isFinite(s.p99Ms)||
        !Number.isFinite(s.errorFraction)||!Number.isFinite(s.cpuPercent)||
        !Number.isFinite(s.rssBytes)||s.connections<0||s.rpcCompleted<0||
        s.errorFraction<0||s.errorFraction>1){
        reasons.push('invalid sample');break;
      }
    }
    if(!reasons.includes('invalid sample')){
      const times=e.samples.map(x=>Date.parse(x.atUtc)).sort((a,b)=>a-b);
      if(times[0]!>Date.parse(e.startedAtUtc)+60000||
        times[times.length-1]!<Date.parse(e.endedAtUtc)-60000)reasons.push('missing soak coverage');
      for(let i=1;i<times.length;i++){
        if(times[i]!-times[i-1]!>120000){reasons.push('more than 2-minute sample gap');break}
      }
    }
  }
  return {accepted:reasons.length===0,elapsedHours:Math.max(0,durationMs)/3600000,
    reasons,warning:'This gate validates reported metadata; external signed provider artifacts still require review.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  assert.equal(process.argv.length,3,'Usage: node --import tsx scripts/s5-soak-acceptance.ts evidence.json');
  const evidence=JSON.parse(readFileSync(process.argv[2]!,'utf8')) as SoakEvidence;
  const r=acceptSoak(evidence);
  process.stdout.write(JSON.stringify(r,null,2)+'\n');
  if(!r.accepted)process.exitCode=2;
}
