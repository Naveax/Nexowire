import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {ProposedS5ProtectedTenantAdmission} from '../../src/ops/scale-s5-protected-admission.js';
const data=workerData as {dbPath:string;tenantId:string;workerId:number;attempts:number;barrier:SharedArrayBuffer};
const A='trusted-account-a1',B='trusted-account-b2';
const db=new DatabaseSync(data.dbPath);
try{
  db.exec('PRAGMA busy_timeout=15000');
  const meter=new ProposedS5ProtectedTenantAdmission(db,{scope:'trusted-staging-scope',
    globalRollingMinuteLimit:100,
    tenants:[{tenantId:A,weight:1},{tenantId:B,weight:1}]});
  const gate=new Int32Array(data.barrier);
  parentPort?.postMessage({kind:'ready'});
  if(Atomics.wait(gate,0,0,10000)==='timed-out')throw new Error('Startup timeout');
  const fingerprint=createHash('sha256').update('canonical-staging-tool').digest('hex');
  let accepted=0,tenantDenied=0,other=0;
  for(let i=0;i<data.attempts;i++){
    const r=meter.observe(data.tenantId,'parallel-fair-'+data.workerId+'-'+i,
      fingerprint,new Date('2026-10-18T12:00:00Z'));
    if(r.status==='reserved')accepted++;
    else if(r.status==='tenant-exhausted')tenantDenied++;
    else other++;
    if(r.authorizesToolExecution!==false)throw new Error('Untrusted native tool dispatch');
  }
  parentPort?.postMessage({kind:'done',accepted,tenantDenied,other});
}catch(error){
  parentPort?.postMessage({kind:'error',message:error instanceof Error?error.message:'unknown'});
  process.exitCode=1;
}finally{db.close()}
