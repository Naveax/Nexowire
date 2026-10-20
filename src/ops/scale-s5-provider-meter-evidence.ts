/**
 * S5 evidence-only Cloudflare meter reconciliation.
 * No network, Cloudflare secrets, billing action, or production mutation.
 * These are operator-imported snapshots, NEVER first-party verified telemetry.
 */
export interface S5CloudflareSnapshot {
  source:'operator-export-unverified';
  accountRef:string;
  workerRef:string;
  d1Ref:string|null;
  durableObjectNamespaceRef:string|null;
  capturedAtUtc:string;
  workerRequests:number|null;
  workerCpuMs:number|null;
  d1RowsRead:number|null;
  d1RowsWritten:number|null;
  doRequestUnits:number|null;
  doDurationGbSeconds:number|null;
}
export interface S5CloudflareDelta {
  classification:'UNVERIFIED_IMPORT_NOT_PROVIDER_BILLING_PROOF';
  accountRef:string;
  intervalSeconds:number;
  workerRequests:number|null;
  workerCpuMs:number|null;
  d1RowsRead:number|null;
  d1RowsWritten:number|null;
  doRequestUnits:number|null;
  doDurationGbSeconds:number|null;
  workerRequestsPerQuotaReservation:number|null;
  workerRequestsPerVerifiedNativeCompletion:null;
  providerAuthenticated:false;
  providerCostUsd:null;
  zeroIncrementalInvoiceProven:false;
  warnings:string[];
}
function utc(v:string){
  if(typeof v!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/.test(v))throw new Error('Invalid UTC ISO timestamp');
  const n=Date.parse(v);
  if(!Number.isFinite(n))throw new Error('Invalid UTC timestamp');
  return n;
}
function ref(v:string){
  if(typeof v!=='string'||!/^[a-zA-Z0-9_.:@/-]{6,160}$/.test(v))throw new Error('Invalid opaque account/resource reference');
}
function delta(b:number|null,a:number|null,label:string):number|null{
  if(b===null||a===null)return null;
  const fractional=label==='doDurationGbSeconds'||label==='workerCpuMs';
  if(!Number.isFinite(b)||!Number.isFinite(a)||b<0||a<b||a>Number.MAX_SAFE_INTEGER||
    (!fractional&&(!Number.isSafeInteger(b)||!Number.isSafeInteger(a)))){
    throw new Error('Invalid or decreasing Cloudflare counter: '+label);
  }
  return fractional?Number((a-b).toFixed(6)):a-b;
}
export function compareS5CloudflareWindows(
  before:S5CloudflareSnapshot,after:S5CloudflareSnapshot,
  quotaReservations:number|null,
):S5CloudflareDelta {
  if(!before||!after||before.source!=='operator-export-unverified'||
     after.source!=='operator-export-unverified')throw new Error('Untrusted provider snapshot shape');
  ref(before.accountRef);ref(before.workerRef);
  if(before.d1Ref!==null)ref(before.d1Ref);
  if(before.durableObjectNamespaceRef!==null)ref(before.durableObjectNamespaceRef);
  const keys=['accountRef','workerRef','d1Ref','durableObjectNamespaceRef'] as const;
  if(keys.some(k=>before[k]!==after[k]))throw new Error('Account or resource mismatch between snapshots');
  const seconds=(utc(after.capturedAtUtc)-utc(before.capturedAtUtc))/1000;
  if(!Number.isInteger(seconds)||seconds<1||seconds>86400)throw new Error('Unbounded or reversed sampling window');
  const present=(v:number|null,label:string)=>{
    if(v!==null&&(!Number.isSafeInteger(v)||v<0))throw new Error('Invalid '+label);
  };
  if(quotaReservations!==null)present(quotaReservations,'quota reservations');
  const usage={
    workerRequests:delta(before.workerRequests,after.workerRequests,'workerRequests'),
    workerCpuMs:delta(before.workerCpuMs,after.workerCpuMs,'workerCpuMs'),
    d1RowsRead:delta(before.d1RowsRead,after.d1RowsRead,'d1RowsRead'),
    d1RowsWritten:delta(before.d1RowsWritten,after.d1RowsWritten,'d1RowsWritten'),
    doRequestUnits:delta(before.doRequestUnits,after.doRequestUnits,'doRequestUnits'),
    doDurationGbSeconds:delta(before.doDurationGbSeconds,after.doDurationGbSeconds,'doDurationGbSeconds'),
  };
  if(before.d1Ref===null&&(usage.d1RowsRead!==null||usage.d1RowsWritten!==null)){
    throw new Error('D1 metrics supplied without verified D1 resource identity');
  }
  if(before.durableObjectNamespaceRef===null&&
     (usage.doRequestUnits!==null||usage.doDurationGbSeconds!==null)){
    throw new Error('DO metrics supplied without DO namespace identity');
  }
  const ratio=quotaReservations&&usage.workerRequests!==null?
    Number((usage.workerRequests/quotaReservations).toFixed(6)):null;
  return {
    classification:'UNVERIFIED_IMPORT_NOT_PROVIDER_BILLING_PROOF',
    accountRef:before.accountRef,intervalSeconds:seconds,...usage,
    workerRequestsPerQuotaReservation:ratio,
    workerRequestsPerVerifiedNativeCompletion:null,
    providerAuthenticated:false,providerCostUsd:null,zeroIncrementalInvoiceProven:false,
    warnings:[
      'Operator-supplied snapshots are unauthenticated: verify against account dashboard/API and immutable query IDs',
      'Worker HTTP, D1 row, and Durable Object message/duration meters are distinct billing dimensions',
      'Missing provider fields are unknown, never zero and never proof of no incremental invoice',
      'Quota reservation is not a native tool completion or upstream provider success',
      'Snapshot deltas can include unrelated tenant traffic; isolated staging scope and baseline required',
    ],
  };
}
