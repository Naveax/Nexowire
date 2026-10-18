/**
 * S5 source-separated operator resource accounting.
 * No direct provider connectivity, no claims of verified provenance.
 * This must not be imported into authorization, quota or production runtime.
 */
export type S5MetricOrigin='synthetic-fixture'|'operator-unverified-export';
export interface S5ObservedCounters{
  origin:S5MetricOrigin;
  intervalSeconds:number;
  quotaReservations:number;
  nativeCompletedReported:number;
  nativeFailedReported:number;
  nativeUnknownReported:number;
  workerHttpRequests:number;
  d1RowsRead:number;
  d1RowsWritten:number;
  durableObjectRequestUnits:number;
  durableObjectDurationGbSeconds:number;
  relayEgressBytes:number;
  wssPeakConnections:number;
  reconnects:number;
  cpuMeanPercent:number;
  rssPeakBytes:number;
  sourceSha256?:string;
}
export interface S5ResourceReconciliation{
  classification:'COUNTER_RECONCILIATION_UNVERIFIED';
  origin:S5MetricOrigin;
  perSecond:{quotaReservations:number;nativeCompletionsReported:number;
    verifiedNativeCompletions:null};
  totals:{quotaReservations:number;nativeCompletedReported:number;
    nativeFailedReported:number;nativeUnknownReported:number;
    verifiedNativeCompletions:0};
  workerRequestsPerReservation:number|null;
  workerRequestsPerReportedCompletion:number|null;
  d1WritesPerReservation:number|null;
  d1ReadsPerReservation:number|null;
  potentiallyUnfinishedReservations:number;
  noToolExecutionProof:true;
  zeroExtraCloudBillProven:false;
  providerMetricsAuthenticated:false;
  notes:string[];
}
function validNonnegativeSafeInteger(v:number){
  return Number.isSafeInteger(v)&&v>=0;
}
export function reconcileS5ResourceCounters(s:S5ObservedCounters):S5ResourceReconciliation{
  if(!s||typeof s!=='object'||!['synthetic-fixture','operator-unverified-export'].includes(s.origin)){
    throw new Error('Unsupported S5 source classification');
  }
  const ints=[
    s.intervalSeconds,s.quotaReservations,s.nativeCompletedReported,
    s.nativeFailedReported,s.nativeUnknownReported,s.workerHttpRequests,
    s.d1RowsRead,s.d1RowsWritten,s.durableObjectRequestUnits,
    s.relayEgressBytes,s.wssPeakConnections,
    s.reconnects,s.rssPeakBytes,
  ];
  if(!ints.every(validNonnegativeSafeInteger)||s.intervalSeconds<1||s.intervalSeconds>86400||
     !Number.isFinite(s.cpuMeanPercent)||s.cpuMeanPercent<0||s.cpuMeanPercent>100||
     !Number.isFinite(s.durableObjectDurationGbSeconds)||
     s.durableObjectDurationGbSeconds<0||s.durableObjectDurationGbSeconds>1e12||
     (s.sourceSha256!==undefined&&!/^[a-f0-9]{64}$/.test(s.sourceSha256))){
    throw new Error('Unsafe or untraceable counter batch');
  }
  const outcomes=s.nativeCompletedReported+s.nativeFailedReported+s.nativeUnknownReported;
  if(!Number.isSafeInteger(outcomes)||outcomes>s.quotaReservations){
    throw new Error('Native outcomes exceed reservations; ledger inconsistent');
  }
  const ratio=(n:number,d:number)=>d===0?null:Number((n/d).toFixed(6));
  return {
    classification:'COUNTER_RECONCILIATION_UNVERIFIED',origin:s.origin,
    perSecond:{quotaReservations:ratio(s.quotaReservations,s.intervalSeconds)!,
      nativeCompletionsReported:ratio(s.nativeCompletedReported,s.intervalSeconds)!,
      verifiedNativeCompletions:null},
    totals:{quotaReservations:s.quotaReservations,
      nativeCompletedReported:s.nativeCompletedReported,
      nativeFailedReported:s.nativeFailedReported,
      nativeUnknownReported:s.nativeUnknownReported,
      verifiedNativeCompletions:0},
    workerRequestsPerReservation:ratio(s.workerHttpRequests,s.quotaReservations),
    workerRequestsPerReportedCompletion:ratio(s.workerHttpRequests,s.nativeCompletedReported),
    d1WritesPerReservation:ratio(s.d1RowsWritten,s.quotaReservations),
    d1ReadsPerReservation:ratio(s.d1RowsRead,s.quotaReservations),
    potentiallyUnfinishedReservations:s.quotaReservations-outcomes,
    noToolExecutionProof:true,zeroExtraCloudBillProven:false,providerMetricsAuthenticated:false,
    notes:[
      'A quota reservation, HTTP charge, WebSocket frame and completed native OS effect are distinct events',
      'Synthetic and operator self-reported completions NEVER count as independently verified tool outcomes',
      'No provider-authenticated invoice, signed completion artifact or deployment-specific DO topology',
      'Missing completion information is UNKNOWN, not success; never blindly replay mutations',
      'Do not derive 850000 completed actions/day from a quota setting or 600/min ingress ceiling',
    ],
  };
}
