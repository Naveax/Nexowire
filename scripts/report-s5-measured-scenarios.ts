/** Produces versioned reproducible LOCAL synthetic measurement artifacts only. */
import {cpus,totalmem,platform,release} from 'node:os';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {runS5LoopbackLoad} from './bench-s5-loopback-ws-capacity.js';
import {projectS5Matrix} from '../src/ops/scale-s5-cost-envelope.js';
const safeSha=()=>{
  try{return execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()}
  catch{return 'unavailable'}
};
async function main(){
  const sourceSha=safeSha();
  const results=[];
  for(const clients of [16,32,64,100,256]){
    const r=await runS5LoopbackLoad({clients,callsPerClient:2,mode:'isolated'});
    if(r.rpc.reserved!==clients*2||r.rpc.other!==0||r.rpc.backpressure!==0||
      r.rpc.rateLimited!==0||r.rpc.duplicate!==Math.min(8,clients)){
      throw new Error('Scenario failed acceptance consistency check: '+clients);
    }
    results.push(r);
  }
  const report={schema:'nexowire-s5-local-synthetic-v1',
    observedAtUtc:new Date().toISOString(),sourceSha,
    host:{platform:platform(),release:release(),cpu:cpus()[0]?.model,
      logicalCores:cpus().length,totalMemoryBytes:totalmem(),node:process.version},
    resultKind:'MEASURED_LOCAL_WS_SOCKETS_AND_OWNER_SQLITE_RESERVATIONS',
    providerCountersMeasured:false,tlsMeasured:false,mcpMeasured:false,
    nativeCompletionMeasured:false,stagingAuthorized:false,
    soak24hElapsed:false,productionAccepted:false,
    results,costModel:{classification:'ASSUMPTIONS_ONLY_NOT_OBSERVED_BILL',
      matrix:projectS5Matrix()}};
  const out=path.resolve('docs/reports/s5-local-synthetic-20261018.json');
  mkdirSync(path.dirname(out),{recursive:true});
  writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({file:out,sourceSha,
    scenarios:results.map(x=>({clients:x.clients,peakSockets:x.sockets.peak,
      acceptedReservations:x.rpc.reserved,wallMs:x.elapsedMs,p99Ms:x.latencyMs.p99,
      rssPeakBytes:x.memoryBytes.rssPeak,backpressure:x.rpc.backpressure,
      fairnessJain:x.fairness.jainIndex}))},null,2)+'\n');
}
void main().catch(error=>{process.stderr.write(String(error)+'\n');process.exitCode=1});
