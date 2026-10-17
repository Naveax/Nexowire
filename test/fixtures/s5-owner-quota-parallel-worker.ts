/**
 * DEV-only worker for physically simultaneous SQLite reservation attempts.
 * Imported by ONE localhost test; never packaged or run by Nexowire Agent.
 */
import {workerData,parentPort} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {ProposedTrustedOwnerQuotaAuthority}
  from '../../src/product/trusted-owner-quota-authority-proposal.js';

interface WorkerInput{
  sqlitePath:string;
  workerIndex:number;
  uniqueAttempts:number;
  barrier:SharedArrayBuffer;
}
const info=workerData as WorkerInput;
const db=new DatabaseSync(info.sqlitePath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=30000;');
const fingerprint=createHash('sha256').update('s5-parallel-read-canonical').digest('hex');
const authority=new ProposedTrustedOwnerQuotaAuthority(
  db,
  async token=>token==='benchmark-real-concurrency-token-0001'
    ?{accountId:'benchmark-concurrency-account-0001',sessionGeneration:1}
    :null,
  ()=>new Date('2026-10-17T12:00:00.000Z'),
);
const send=async(invocationId:string)=>authority.reserveLogicalTool({
  bearerToken:'benchmark-real-concurrency-token-0001',
  deviceId:'benchmark-concurrency-device-0001',
  invocationId,
  toolFingerprint:fingerprint,
  operationClass:'read',
});
const tally={reserved:0,duplicate:0,'daily-exhausted':0,other:[] as string[]};
try{
  parentPort?.postMessage({kind:'ready',index:info.workerIndex});
  const start=new Int32Array(info.barrier);
  const gate=Atomics.wait(start,0,0,15000);
  if(gate==='timed-out')throw new Error('S5 worker start barrier timed out');
  const invoke=async(id:string)=>{
    const result=await send(id);
    if(result.authorizesToolExecution!==false){
      throw new Error('Reservation unexpectedly granted native tool execution');
    }
    if(result.status==='reserved'||result.status==='duplicate'||
      result.status==='daily-exhausted')tally[result.status]++;
    else tally.other.push(result.status);
  };
  // Every worker first races over an identical canonical logical invocation ID.
  await invoke('benchmark-shared-invocation-0001');
  for(let i=0;i<info.uniqueAttempts;i++){
    await invoke('benchmark-unique-'+String(info.workerIndex).padStart(2,'0')+
      '-'+String(i).padStart(5,'0'));
  }
  parentPort?.postMessage({kind:'done',index:info.workerIndex,tally});
}catch(e){
  parentPort?.postMessage({
    kind:'error',index:info.workerIndex,
    error:e instanceof Error?e.message:'unknown-worker-exception',
  });
  process.exitCode=1;
}finally{
  db.close();
}
