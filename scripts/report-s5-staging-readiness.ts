/**
 * Read-only S5 staging evidence inspector.
 * With NO arguments: fail-closed readiness report, no network calls.
 * Optional JSON is operator-imported evidence, not authenticated by this CLI.
 */
import {readFileSync,statSync} from 'node:fs';
import {assessS5StagingEvidence,type S5CanaryAuthorization,type S5StagingObservation}
  from '../src/ops/scale-s5-staging-acceptance.js';
import {compareS5CloudflareWindows,type S5CloudflareSnapshot}
  from '../src/ops/scale-s5-provider-meter-evidence.js';
interface Manifest {
  authorization?:S5CanaryAuthorization|null;
  observation?:S5StagingObservation|null;
  providerBefore?:S5CloudflareSnapshot|null;
  providerAfter?:S5CloudflareSnapshot|null;
}
function run(){
  if(process.argv.length>3){
    throw new Error('Usage: node --import tsx scripts/report-s5-staging-readiness.ts [evidence.json]');
  }
  let evidence:Manifest={};
  if(process.argv[2]){
    const path=process.argv[2];
    if(!path.endsWith('.json'))throw new Error('Evidence must be a JSON file');
    if(statSync(path).size>1024*1024)throw new Error('Oversized evidence file');
    evidence=JSON.parse(readFileSync(path,'utf8')) as Manifest;
    if(!evidence||typeof evidence!=='object'||Array.isArray(evidence)){
      throw new Error('Invalid evidence');
    }
  }
  const gates=assessS5StagingEvidence(evidence.authorization??null,evidence.observation??null);
  let providerDelta:null|ReturnType<typeof compareS5CloudflareWindows>=null;
  let providerIssue:string|null=null;
  if(evidence.providerBefore||evidence.providerAfter){
    if(!evidence.providerBefore||!evidence.providerAfter){
      providerIssue='Both before/after Cloudflare snapshots are required';
    }else {
      try{
        providerDelta=compareS5CloudflareWindows(evidence.providerBefore,
          evidence.providerAfter,evidence.observation?.ownerQuotaReservations??null);
      }catch(e){providerIssue=e instanceof Error?e.message:'Malformed provider counters'}
    }
  }
  const result={
    kind:'S5_READ_ONLY_EVIDENCE_AUDIT',
    staging:gates,
    cloudflare:{usageDelta:providerDelta,status:'UNVERIFIED_OPERATOR_IMPORT_ONLY',
      issue:providerIssue??(!providerDelta?'NO_ACCOUNT_METER_EXPORT':'EXTERNAL_AUTHENTICATION_MISSING')},
    native:{independentlyVerifiedToolCompletions:null,
      status:'BLOCKED_NO_AUTHENTICATED_AGENT_JOURNAL_RECEIPTS'},
    priorLocalTests:'SOURCE_ONLY_DO_NOT_COUNT_AS_PUBLIC_WSS',
    cloudResourcesCreated:0,
    externalRequestsIssued:0,
    newAgentToolExecutions:0,
    paidResourcesChanged:false,
    productionAcceptance:'NO_GO',
  };
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  // Exit 2 for any non-confirmed staging (even self-submitted structurally complete evidence).
  if(gates.stagingStatus!=='NEEDS_INDEPENDENT_AUDIT'||providerIssue||!providerDelta)process.exitCode=2;
}
try{run()}catch(e){
  process.stderr.write('S5 fail-closed audit error: '+String(e)+'\n');
  process.exitCode=2;
}
