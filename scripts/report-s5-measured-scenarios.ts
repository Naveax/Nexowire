/** Produces versioned reproducible LOCAL synthetic measurement artifacts only. */
import {cpus,totalmem,platform,release} from 'node:os';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runS5LoopbackLoad,type S5LoadResult} from './bench-s5-loopback-ws-capacity.js';
import {projectS5Matrix} from '../src/ops/scale-s5-cost-envelope.js';

/** Offline presentation only. A synthetic socket count is never a provider capacity estimate. */
export function summarizeS5ScenarioResults(results:readonly S5LoadResult[]){
  if(!Array.isArray(results))throw new Error('Scenario results must be an array');
  const scenarios=results.map(r=>{
    if(!r||r.kind!=='SYNTHETIC_LOOPBACK_WS_OWNER_SQLITE')
      throw new Error('Invalid scenario kind');
    // JSON.stringify converts NaN/Infinity to null. Reject even a nested
    // counter that is not selected for the console summary before writing JSON.
    const pending:unknown[]=[r];
    const visited=new WeakSet<object>();
    while(pending.length){
      const value=pending.pop();
      if(typeof value==='number'&&!Number.isFinite(value))
        throw new Error('Invalid nonfinite scenario value');
      if(value&&typeof value==='object'){
        if(visited.has(value))throw new Error('Invalid repeated scenario reference');
        visited.add(value);
        pending.push(...Object.values(value));
      }
    }
    const integer=(n:number)=>Number.isSafeInteger(n)&&n>=0;
    const finite=(n:number)=>Number.isFinite(n)&&n>=0;
    const {p50,p95,p99,max}=r.latencyMs;
    if(!integer(r.clients)||r.clients===0||!integer(r.rpc.attempted)||
      !integer(r.rpc.reserved)||!integer(r.sockets.peak)||
      !integer(r.rpc.backpressure)||!finite(r.elapsedMs)||
      !finite(r.memoryBytes.rssPeak)||!finite(r.fairness.jainIndex)||
      ![p50,p95,p99,max].every(finite)||
      p50>p95||p95>p99||p99>max)
      throw new Error('Invalid or non-monotonic scenario measurement');
    // The fixture records one latency for every completed attempt; a report
    // without attempts cannot prove percentiles, even if it contains zeroes.
    if(r.rpc.attempted===0)throw new Error('Missing latency samples');
    if(r.rpc.attempted===1&&!(p50===p95&&p95===p99&&p99===max))
      throw new Error('Invalid single-sample percentiles');
    return {clients:r.clients,peakSockets:r.sockets.peak,
      acceptedReservations:r.rpc.reserved,wallMs:r.elapsedMs,
      p99Ms:p99,rssPeakBytes:r.memoryBytes.rssPeak,
      backpressure:r.rpc.backpressure,fairnessJain:r.fairness.jainIndex};
  });
  scenarios.sort((a,b)=>a.clients-b.clients);
  if(new Set(scenarios.map(r=>r.clients)).size!==scenarios.length)
    throw new Error('Duplicate scenario client count');
  return {measurementClassification:scenarios.length?'LOCAL_SYNTHETIC_ONLY':'UNKNOWN',
    capacityEstimate:null,providerCapacityProven:false,scenarios};
}
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
  const summary=summarizeS5ScenarioResults(results);
  const report={schema:'nexowire-s5-local-synthetic-v1',
    observedAtUtc:new Date().toISOString(),sourceSha,
    host:{platform:platform(),release:release(),cpu:cpus()[0]?.model,
      logicalCores:cpus().length,totalMemoryBytes:totalmem(),node:process.version},
    resultKind:'MEASURED_LOCAL_WS_SOCKETS_AND_OWNER_SQLITE_RESERVATIONS',
    providerCountersMeasured:false,tlsMeasured:false,mcpMeasured:false,
    nativeCompletionMeasured:false,stagingAuthorized:false,
    soak24hElapsed:false,productionAccepted:false,
    results,summary,costModel:{classification:'ASSUMPTIONS_ONLY_NOT_OBSERVED_BILL',
      matrix:projectS5Matrix()}};
  const out=path.resolve('docs/reports/s5-local-synthetic-20261018.json');
  mkdirSync(path.dirname(out),{recursive:true});
  writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({file:out,sourceSha,...summary},null,2)+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  void main().catch(error=>{process.stderr.write(String(error)+'\n');process.exitCode=1});
}
