import {
  probeIsolatedD1Staging,
  validateIsolatedD1Staging,
} from '../src/ops/scale-v2-d1-staging-preflight.js';

/** No --deploy, --apply, --migrate or write mode exists by design. */
async function main():Promise<void>{
  const args=process.argv.slice(2);
  if(args.length>1 || (args.length===1 && args[0]!=='--probe')){
    throw new Error('Only optional --probe (Cloudflare REST read-only) is allowed');
  }
  const configuration=validateIsolatedD1Staging(process.env);
  if(configuration.status==='BLOCKED'){
    process.stdout.write(JSON.stringify({...configuration,
      stage:'REMOTE_D1_PREFLIGHT',distributedWorkerAcceptance:false})+'\n');
    process.exitCode=2;
    return;
  }
  if(args.length===0){
    process.stdout.write(JSON.stringify({...configuration,
      stage:'REMOTE_D1_PREFLIGHT',distributedWorkerAcceptance:false,
      reason:'NOT_PROBED_RUN_WITH_EXPLICIT_PROBE_FLAG'})+'\n');
    process.exitCode=2;
    return;
  }
  const evidence=await probeIsolatedD1Staging(configuration,
    process.env.NEXOWIRE_CF_STAGING_READ_TOKEN??'');
  process.stdout.write(JSON.stringify(evidence)+'\n');
  // Schema proof alone cannot meet distributed Worker acceptance.
  // Returning nonzero avoids CI consumers mistaking it for production PASS.
  process.exitCode=2;
}

void main().catch(()=>{
  process.stdout.write(JSON.stringify({status:'BLOCKED',
    reason:'REMOTE_D1_PREFLIGHT_FAILED',liveD1Tested:false,
    distributedWorkerAcceptance:false,costAccepted:false,
    productionEntitlementsAccepted:false})+'\n');
  process.exitCode=2;
});
