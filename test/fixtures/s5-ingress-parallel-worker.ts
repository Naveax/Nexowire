/** Bounded TEST-ONLY cross-thread ingress budget race: NEVER connects externally. */
import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {ProposedAllIngressTransportMeter} from '../../src/mcp/all-ingress-transport-meter-proposal.js';
type Config={databasePath:string;workerIndex:number;attempts:number;windowLimit:number;barrier:SharedArrayBuffer;atUtc:string};
const c=workerData as Config;
const db=new DatabaseSync(c.databasePath);
try{
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=30000;');
  const meter=new ProposedAllIngressTransportMeter(db,c.windowLimit);
  const signal=new Int32Array(c.barrier);
  parentPort?.postMessage({kind:'ready',workerIndex:c.workerIndex});
  if(Atomics.wait(signal,0,0,15000)==='timed-out')throw new Error('Barrier timeout');
  let admitted=0,denied=0,retryMin=60001,retryMax=0;
  for(let n=0;n<c.attempts;n++){
    // Scope originates from a trusted test fixture, not a request header.
    const decision=meter.observe('trusted-s5-shared-provider-scope',new Date(c.atUtc));
    if(decision.allowed)admitted++;
    else {denied++;retryMin=Math.min(retryMin,decision.retryAfterMs);
      retryMax=Math.max(retryMax,decision.retryAfterMs);}
  }
  parentPort?.postMessage({kind:'done',workerIndex:c.workerIndex,
    admitted,denied,retryMin:denied?retryMin:0,retryMax});
}catch(e){
  parentPort?.postMessage({kind:'failure',workerIndex:c.workerIndex,
    message:e instanceof Error?e.message:'unknown'});
  process.exitCode=1;
}finally{db.close()}
