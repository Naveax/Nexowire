/**
 * READ-ONLY gate for a real, explicitly isolated Cloudflare D1 staging target.
 * No migration, worker deployment, payment provider, quota write or billable
 * invocation. A successful schema probe is NOT a multi-Worker acceptance.
 */
export type D1StagingPreflight =
  | Readonly<{status:'BLOCKED'; reasons:readonly string[]; liveD1Tested:false;
      productionEntitlementsAccepted:false; costAccepted:false}>
  | Readonly<{status:'READY_FOR_READONLY_PROBE';accountId:string;
      databaseId:string;databaseName:string;workerUrl:string;
      liveD1Tested:false;productionEntitlementsAccepted:false;costAccepted:false}>;

const requiredTables=Object.freeze([
  'accounts','devices','quota_subjects','quota_usage_periods',
  'daily_request_periods','daily_request_invocations','dual_quota_reservations',
  'v2_quota_authority','v2_quota_reservations','v2_quota_minute_events',
  'v2_quota_clock',
]);

export function validateIsolatedD1Staging(
  e:Readonly<Record<string,string|undefined>>,
):D1StagingPreflight{
  const reasons:string[]=[];
  const accountId=e.NEXOWIRE_CF_STAGING_ACCOUNT_ID?.trim()??'';
  const databaseId=e.NEXOWIRE_CF_STAGING_DATABASE_ID?.trim()??'';
  const databaseName=e.NEXOWIRE_CF_STAGING_DATABASE_NAME?.trim()??'';
  const url=e.NEXOWIRE_CF_STAGING_WORKER_URL?.trim()??'';
  const token=e.NEXOWIRE_CF_STAGING_READ_TOKEN??'';
  if(e.NEXOWIRE_CF_STAGING_APPROVAL!=='ISOLATED_D1_READ_ONLY'){
    reasons.push('ISOLATED_STAGING_APPROVAL_MISSING');
  }
  if(!/^[a-f\d]{32}$/i.test(accountId))reasons.push('STAGING_ACCOUNT_ID_MISSING');
  if(!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(databaseId)){
    reasons.push('STAGING_DATABASE_ID_MISSING');
  }
  // Never allow the production database name. A D1 GET metadata check below
  // ALSO verifies that this ID actually belongs to this staging database.
  if(!/^nexowire-scale-v2-staging-[a-z0-9-]{3,48}$/.test(databaseName)){
    reasons.push('STAGING_DATABASE_NAME_REQUIRED');
  }
  if(token.length<20 || /^(REPLACE|EXAMPLE|TOKEN)/i.test(token)){
    reasons.push('ISOLATED_READ_TOKEN_MISSING');
  }
  let workerHost='';
  try{
    const parsed=new URL(url);
    if(parsed.protocol==='https:' && parsed.username==='' && parsed.password==='' &&
       parsed.pathname==='/' && parsed.search==='' && parsed.hash==='' &&
       parsed.port==='' && /(^|[.-])staging([.-]|$)/.test(parsed.hostname) &&
       /^[a-z\d.-]+$/.test(parsed.hostname)) workerHost=parsed.origin+'/';
  }catch{/* Invalid target is blocked, never used. */}
  if(!workerHost)reasons.push('ISOLATED_STAGING_WORKER_URL_REQUIRED');
  if(reasons.length)return {status:'BLOCKED',reasons,
    liveD1Tested:false,productionEntitlementsAccepted:false,costAccepted:false};
  return {status:'READY_FOR_READONLY_PROBE',accountId,databaseId,
    databaseName,workerUrl:workerHost,liveD1Tested:false,
    productionEntitlementsAccepted:false,costAccepted:false};
}

export interface D1ReadonlyEvidence{
  status:'BLOCKED'|'REMOTE_D1_SCHEMA_OBSERVED';
  source:'cloudflare-d1-rest-readonly';
  liveD1Tested:boolean;
  distributedWorkerAcceptance:false;
  paymentProofAcceptance:false;
  productionEntitlementsAccepted:false;
  costAccepted:false;
  missingTables:readonly string[];
  rowsRead:number|null;
  reason:string|null;
}

const apiBase='https://api.cloudflare.com/client/v4/accounts/';
function safeResult(reason:string,rowsRead:number|null=null,
  missingTables:readonly string[]=[]):D1ReadonlyEvidence{
  return {status:'BLOCKED',source:'cloudflare-d1-rest-readonly',
    liveD1Tested:false,distributedWorkerAcceptance:false,
    paymentProofAcceptance:false,productionEntitlementsAccepted:false,
    costAccepted:false,missingTables,rowsRead,reason};
}

/**
 * The Cloudflare API calls are GET metadata and a SELECT-only D1 REST query.
 * Supplied token is never returned or logged. No POST request contains INSERT,
 * UPDATE, DELETE, CREATE, DROP, PRAGMA writes or user-controlled SQL.
 */
export async function probeIsolatedD1Staging(
  ready:Extract<D1StagingPreflight,{status:'READY_FOR_READONLY_PROBE'}>,
  token:string,fetchImpl:typeof fetch=fetch,
):Promise<D1ReadonlyEvidence>{
  const prefix=apiBase+ready.accountId+'/d1/database/'+ready.databaseId;
  const opts={Authorization:'Bearer '+token,Accept:'application/json'};
  try{
    const metadata=await fetchImpl(prefix,{method:'GET',headers:opts,
      signal:AbortSignal.timeout(10000)});
    if(!metadata.ok)return safeResult('D1_METADATA_HTTP_'+metadata.status);
    const data=await metadata.json() as {
      success?:boolean;result?:{uuid?:string;id?:string;name?:string};
    };
    if(data.success!==true ||
       (data.result?.uuid??data.result?.id)!==ready.databaseId ||
       data.result?.name!==ready.databaseName){
      return safeResult('D1_IDENTITY_DOES_NOT_MATCH_ISOLATED_STAGING');
    }
    const sql="SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+
      requiredTables.map(()=>'?').join(',')+")";
    const response=await fetchImpl(prefix+'/query',{
      method:'POST',
      headers:{...opts,'Content-Type':'application/json'},
      body:JSON.stringify({sql,params:[...requiredTables]}),
      signal:AbortSignal.timeout(10000),
    });
    if(!response.ok)return safeResult('D1_READONLY_QUERY_HTTP_'+response.status);
    const payload=await response.json() as {
      success?:boolean;result?:Array<{
        success?:boolean;results?:Array<{name?:string}>;
        meta?:{rows_read?:number};
      }>;
    };
    const row=payload.result?.[0];
    if(payload.success!==true||row?.success!==true||!Array.isArray(row.results)){
      return safeResult('D1_SCHEMA_RESPONSE_INVALID');
    }
    const names=new Set(row.results.map(x=>x.name));
    const missingTables=requiredTables.filter(t=>!names.has(t));
    const rowsRead=Number.isSafeInteger(row.meta?.rows_read)?
      (row.meta?.rows_read??null):null;
    if(missingTables.length)return safeResult('D1_STAGING_SCHEMA_INCOMPLETE',
      rowsRead,missingTables);
    return {status:'REMOTE_D1_SCHEMA_OBSERVED',source:'cloudflare-d1-rest-readonly',
      liveD1Tested:true,distributedWorkerAcceptance:false,
      paymentProofAcceptance:false,productionEntitlementsAccepted:false,
      costAccepted:false,missingTables:[],rowsRead,reason:null};
  }catch{
    return safeResult('D1_READONLY_PROBE_FAILED');
  }
}

export const SCALE_V2_REQUIRED_D1_TABLES=requiredTables;
