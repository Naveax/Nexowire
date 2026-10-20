/**
 * S5 staging acceptance contract. This module NEVER opens network sockets.
 * No self-attested JSON can become external staging PASS or production PASS.
 */
export interface S5CanaryAuthorization{
  type:'bounded-external-staging-only';
  approvedHostname:string;
  stagingResourceId:string;
  ownerApprovalRef:string;
  operatorWssTrustProfileSha256:string;
  signedStagingEnrollmentManifestSha256:string;
  distinctAuthorizedAccounts:number;
  distinctAuthorizedDeviceSessions:number;
  maxSimultaneousConnections:number;
  maxPerSecondNewConnections:number;
  maxLogicalRequests:number;
  maxRunSeconds:number;
  paidResourcesAllowed:false;
  nativeReadOnlyOperationApproved:boolean;
  stopOnFirstProviderError:true;
}
export interface S5StagingObservation {
  kind:'externally-observed-unverified';
  targetHost:string;
  sourceCommit:string;
  startedAtUtc:string;
  endedAtUtc:string;
  peakSimultaneousAuthenticatedWss:number;
  peakSimultaneousUnverifiedWss:number;
  distinctAccounts:number;
  distinctAuthorizedDevices:number;
  attemptedReadOnlyNativeTools:number;
  ownerQuotaReservations:number;
  nativeCompletedReported:number;
  nativeCompletedIndependentlyVerified:number;
  p95Ms:number|null;
  p99Ms:number|null;
  reconnectAttempts:number;
  backpressureDenied:number;
  ingressTransportDenied:number;
  simulatedCompletedCount:number;
  externalAuthEvidenceSha256:string|null;
  nativeCompletionArtifactSha256:string|null;
  cloudflareMeterArtifactSha256:string|null;
}
export type S5StagingStatus='BLOCKED'|'NEEDS_INDEPENDENT_AUDIT';
const hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const hostname=(v:string)=>{
  if(typeof v!=='string'||v.length>253||!/^([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(v))return false;
  const x=v.toLowerCase();
  if(x.includes('localhost')||x.endsWith('.local')||x.endsWith('.internal')||x.includes('..'))return false;
  return !x.split('.').some(label=>label.startsWith('-')||label.endsWith('-'));
};
export function validateS5AuthorizedCanary(a:S5CanaryAuthorization):string[]{
  const reasons:string[]=[];
  if(!a||a.type!=='bounded-external-staging-only'||a.paidResourcesAllowed!==false||
     a.stopOnFirstProviderError!==true)reasons.push('missing explicit no-paid-resource bounded authorization');
  if(!hostname(a?.approvedHostname))reasons.push('invalid or missing separately approved public staging hostname');
  if(typeof a?.operatorWssTrustProfileSha256!=='string'||
     !/^[a-f0-9]{64}$/.test(a.operatorWssTrustProfileSha256)||
     typeof a?.signedStagingEnrollmentManifestSha256!=='string'||
     !/^[a-f0-9]{64}$/.test(a.signedStagingEnrollmentManifestSha256)){
    reasons.push('missing TLS-trust profile or signed staging enrollment content hash');
  }
  if(typeof a?.stagingResourceId!=='string'||!/^[a-z0-9_.:@-]{10,160}$/i.test(a.stagingResourceId)){
    reasons.push('missing isolated staging resource identifier');
  }
  if(typeof a?.ownerApprovalRef!=='string'||!/^[a-z0-9_.:@/-]{12,160}$/i.test(a.ownerApprovalRef)){
    reasons.push('missing traceable owner staging approval');
  }
  const dims=[
    [a?.distinctAuthorizedAccounts,2,128],
    [a?.distinctAuthorizedDeviceSessions,101,128],
    [a?.maxSimultaneousConnections,101,128],
    [a?.maxPerSecondNewConnections,1,8],
    [a?.maxLogicalRequests,101,600],
    [a?.maxRunSeconds,10,90],
  ] as const;
  if(dims.some(([n,min,max])=>!Number.isSafeInteger(n)||n<min||n>max)){
    reasons.push('unauthorized or unbounded external staging workload dimensions');
  }
  if(a?.nativeReadOnlyOperationApproved!==true){
    reasons.push('real read-only native operation is not explicitly authorized');
  }
  if(a?.distinctAuthorizedDeviceSessions<a?.maxSimultaneousConnections){
    reasons.push('claimed authentic concurrent sessions exceed separately authorized devices');
  }
  // The supplied approval ID alone is not independently verified, so a
  // structurally valid plan is NOT permission to execute the external test.
  return reasons;
}
export function assessS5StagingEvidence(a:S5CanaryAuthorization|null,o:S5StagingObservation|null){
  const reasons:string[]=[];
  if(!a)reasons.push('no externally approved bounded staging authorization');
  else reasons.push(...validateS5AuthorizedCanary(a));
  if(!o)reasons.push('no measured external authenticated WSS staging evidence');
  else{
    if(o.kind!=='externally-observed-unverified')reasons.push('unrecognized evidence source');
    if(!a||o.targetHost!==a.approvedHostname)reasons.push('measured WSS host differs from approved target');
    if(!/^[0-9a-f]{40}$/.test(o.sourceCommit))reasons.push('source commit missing');
    const s=Date.parse(o.startedAtUtc),e=Date.parse(o.endedAtUtc);
    if(!Number.isFinite(s)||!Number.isFinite(e)||s>=e||e-s>90000)reasons.push('unsafe or missing finite canary interval');
    const ints=[o.peakSimultaneousAuthenticatedWss,o.peakSimultaneousUnverifiedWss,
      o.distinctAccounts,o.distinctAuthorizedDevices,o.attemptedReadOnlyNativeTools,
      o.ownerQuotaReservations,o.nativeCompletedReported,o.nativeCompletedIndependentlyVerified,
      o.reconnectAttempts,o.backpressureDenied,o.ingressTransportDenied,o.simulatedCompletedCount];
    if(ints.some(v=>!Number.isSafeInteger(v)||v<0))reasons.push('invalid or negative workload counters');
    if(o.peakSimultaneousAuthenticatedWss<101||o.distinctAuthorizedDevices<101){
      reasons.push('not 100+ simultaneously authenticated WSS sessions');
    }
    if(a&&(
      o.peakSimultaneousAuthenticatedWss>a.maxSimultaneousConnections||
      o.distinctAuthorizedDevices>a.distinctAuthorizedDeviceSessions||
      o.attemptedReadOnlyNativeTools>a.maxLogicalRequests||
      Number.isFinite(s)&&Number.isFinite(e)&&(e-s)>a.maxRunSeconds*1000
    )){
      reasons.push('actual traffic exceeded operator-approved per-run safety limits');
    }
    if(o.distinctAccounts<2)reasons.push('no independent account isolation evidence');
    if(o.attemptedReadOnlyNativeTools===0||o.nativeCompletedReported===0||
       o.nativeCompletedIndependentlyVerified===0){
      reasons.push('no completed native tool effect proof');
    }
    if(o.nativeCompletedReported>o.ownerQuotaReservations||
       o.nativeCompletedIndependentlyVerified>o.nativeCompletedReported){
      reasons.push('completion counters inconsistent with quota ledger');
    }
    if(o.p95Ms===null||o.p99Ms===null||!Number.isFinite(o.p95Ms)||
       !Number.isFinite(o.p99Ms)||o.p95Ms<0||o.p99Ms<o.p95Ms){
      reasons.push('p95/p99 real tool latency missing or malformed');
    }
    if(!hex(o.externalAuthEvidenceSha256)||!hex(o.nativeCompletionArtifactSha256)||
       !hex(o.cloudflareMeterArtifactSha256)){
      reasons.push('missing content-addressed operator/WSS/native/Cloudflare evidence');
    }
    if(o.simulatedCompletedCount>0)reasons.push('simulated native effects included in staging result');
  }
  return {
    sourceAcceptance:'SOURCE_TESTS_MUST_BE_VERIFIED_SEPARATELY',
    stagingStatus:(reasons.length?'BLOCKED':'NEEDS_INDEPENDENT_AUDIT') as S5StagingStatus,
    productionStatus:'NO_GO' as const,
    native24HourSoakStatus:'NOT_VERIFIED' as const,
    independentlyAuthenticatedEvidence:false as const,
    reasons,
    note:'Manifest fields and SHA strings cannot authenticate a provider, an owner approval or an OS tool completion; require independent verifier artifacts.',
  };
}
