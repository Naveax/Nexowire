/**
 * S5 metadata-only structural evidence validator. This is NOT an independent
 * certification of provider receipts, owner approval, or physical load.
 * Never issues network calls, opens sockets, or runs traffic.
 */
import assert from 'node:assert/strict';
import {readFileSync,statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export interface SoakSample{
  atUtc:string;connections:number;rpcCompleted:number;
  p99Ms:number;errorFraction:number;cpuPercent:number;rssBytes:number;
}
export interface SoakEvidence{
  sourceCommit:string;environment:'authorized-staging';
  startedAtUtc:string;endedAtUtc:string;
  samples:SoakSample[];
  providerCountersVerified:boolean;
  executionCompletionCountersVerified:boolean;
  ownerApprovalRecorded:boolean;
  outageOrSpendingIncident:boolean;
  // Content-addressed evidence references; hashes alone prove no authenticity.
  providerCountersArtifactSha256?:string;
  executionCountersArtifactSha256?:string;
  ownerApprovalReference?:string;
}
const utc=(s:string):number=>{
  if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s)){
    return NaN;
  }
  return Date.parse(s);
};
const hash=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
export function acceptSoak(e:SoakEvidence){
  const reasons:string[]=[];
  if(!e || typeof e!=='object')return {accepted:false,productionAccepted:false,
    elapsedHours:0,reasons:['invalid evidence'],warning:'Metadata-only validation.'};
  const started=utc(e.startedAtUtc),ended=utc(e.endedAtUtc);
  const durationMs=ended-started;
  if(e.environment!=='authorized-staging')reasons.push('not authorized staging');
  if(typeof e.sourceCommit!=='string'||!/^[a-f0-9]{40}$/.test(e.sourceCommit)){
    reasons.push('unverified source SHA');
  }
  if(!Number.isFinite(durationMs)||durationMs<86400000){
    reasons.push('less than 24 hours elapsed');
  }
  if(!e.ownerApprovalRecorded||typeof e.ownerApprovalReference!=='string'||
    !/^[A-Za-z0-9.:_\/-]{8,200}$/.test(e.ownerApprovalReference)){
    reasons.push('missing traceable staging approval');
  }
  if(!e.providerCountersVerified||!hash(e.providerCountersArtifactSha256)){
    reasons.push('missing content-addressed provider counters');
  }
  if(!e.executionCompletionCountersVerified||!hash(e.executionCountersArtifactSha256)){
    reasons.push('missing content-addressed completed-tool counters');
  }
  if(e.outageOrSpendingIncident!==false)reasons.push('incident or unverified incident state');
  if(!Array.isArray(e.samples)||e.samples.length<1440||e.samples.length>20000){
    reasons.push('missing or oversized minute interval samples');
  }else{
    let lastTime=-Infinity,lastCompleted=-1;
    let zeroCompletion=true;
    let invalid=false,nonmonotonic=false,gap=false,outOfWindow=false;
    for(const s of e.samples){
      if(!s||typeof s!=='object'){invalid=true;break}
      const t=utc(s.atUtc);
      const counts=[s.connections,s.rpcCompleted,s.rssBytes];
      if(!Number.isFinite(t)||
        !counts.every(x=>Number.isSafeInteger(x)&&x>=0)||
        ![s.p99Ms,s.errorFraction,s.cpuPercent].every(x=>Number.isFinite(x))||
        s.p99Ms<0||s.errorFraction<0||s.errorFraction>1||
        s.cpuPercent<0||s.cpuPercent>100){
        invalid=true;break;
      }
      if(t<started||t>ended)outOfWindow=true;
      if(t<=lastTime||s.rpcCompleted<lastCompleted)nonmonotonic=true;
      if(lastTime!==-Infinity&&t-lastTime>120000)gap=true;
      if(s.rpcCompleted>0)zeroCompletion=false;
      lastTime=t;lastCompleted=s.rpcCompleted;
    }
    if(invalid)reasons.push('invalid sample');
    else {
      if(nonmonotonic)reasons.push('duplicate or out-of-order time / regressing completion counter');
      if(gap)reasons.push('more than 2-minute sample gap');
      if(outOfWindow)reasons.push('sample outside stated window');
      if(zeroCompletion)reasons.push('no reported completed native tool');
      const first=utc(e.samples[0]!.atUtc),last=utc(e.samples[e.samples.length-1]!.atUtc);
      if(!Number.isFinite(durationMs)||first>started+60000||last<ended-60000){
        reasons.push('missing soak coverage');
      }
    }
  }
  return {accepted:reasons.length===0,productionAccepted:false,
    elapsedHours:Number.isFinite(durationMs)?Math.max(0,durationMs)/3600000:0,
    reasons,warning:'A metadata PASS is not production acceptance. Independently verify signed provider reports, approval, connection logs, authentic 24h completion and invoice evidence.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  assert.equal(process.argv.length,3,'Usage: node --import tsx scripts/s5-soak-acceptance.ts evidence.json');
  const filename=process.argv[2]!;
  if(statSync(filename).size>10_000_000)throw new Error('Evidence exceeds 10MB parser bound');
  const evidence=JSON.parse(readFileSync(filename,'utf8')) as SoakEvidence;
  const result=acceptSoak(evidence);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(!result.accepted)process.exitCode=2;
}
