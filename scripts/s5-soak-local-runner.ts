/**
 * Scheduled, bounded local-only 24h diagnostic traffic generator.
 * IMPORTANT: resets the synthetic SQLite fixture every minute; therefore it is
 * NOT a continuous auth/DB/WSS soak and cannot satisfy real staging acceptance.
 * Requires explicit CLI acknowledgment for >5 minutes. Never targets internet.
 */
import {setTimeout as sleep} from 'node:timers/promises';
import {writeFileSync,appendFileSync} from 'node:fs';
import {runS5LoopbackLoad} from './bench-s5-loopback-ws-capacity.js';
const parse=(args:string[])=>{
  const opts:Record<string,string>={};
  for(const s of args){
    if(s==='--ack-long-running')continue;
    const m=/^--(minutes|clients|file)=([A-Za-z0-9_./\\:-]+)$/.exec(s);
    if(!m||opts[m[1]!]!==undefined)throw new Error('Unknown or duplicate argument '+s);
    opts[m[1]!]=m[2]!;
  }
  const minutes=Number(opts.minutes??1),clients=Number(opts.clients??16);
  if(!Number.isSafeInteger(minutes)||minutes<1||minutes>1440||
    !Number.isSafeInteger(clients)||clients<1||clients>32)throw new Error('Unsafe local soak dimensions');
  if(minutes>5&&!args.includes('--ack-long-running')){
    throw new Error('To execute >5 minutes, append --ack-long-running explicitly');
  }
  return {minutes,clients,file:opts.file??'s5-local-soak.ndjson'};
};
async function run(){
  const args=process.argv.slice(2);
  const options=parse(args);
  const started=Date.now(),deadline=started+options.minutes*60000;
  let stopped=false;
  process.once('SIGINT',()=>{stopped=true});
  process.once('SIGTERM',()=>{stopped=true});
  writeFileSync(options.file,JSON.stringify({type:'start',kind:'LOCAL_RESETTING_FIXTURE_NOT_24H_STAGING_ACCEPTANCE',
    startedAt:new Date(started).toISOString(),requestedMinutes:options.minutes,clients:options.clients})+'\n',
    {flag:'wx'});
  let sample=0;
  while(!stopped&&Date.now()<deadline){
    const t=Date.now();
    try{
      const r=await runS5LoopbackLoad({clients:options.clients,mode:'isolated'});
      appendFileSync(options.file,JSON.stringify({type:'sample',time:new Date().toISOString(),
        elapsedMs:Date.now()-started,sample:++sample,
        clients:r.sockets.connected,successfulReservations:r.rpc.reserved,
        realToolCompletions:0,p99Ms:r.latencyMs.p99,queue:r.rpc.peakQueue,
        backpressure:r.rpc.backpressure,cpuMs:r.cpuMs,memoryBytes:r.memoryBytes,
        classification:r.kind})+'\n');
    }catch(e){
      appendFileSync(options.file,JSON.stringify({type:'error',time:new Date().toISOString(),
        error:e instanceof Error?e.message:String(e)})+'\n');
      process.exitCode=2;break;
    }
    await sleep(Math.max(0,60000-(Date.now()-t)));
  }
  appendFileSync(options.file,JSON.stringify({type:'finish',time:new Date().toISOString(),
    elapsedMs:Date.now()-started,samples:sample,interrupted:stopped,
    acceptedAs24hStaging:false})+'\n');
}
void run().catch(e=>{process.stderr.write(String(e)+'\n');process.exitCode=2});
