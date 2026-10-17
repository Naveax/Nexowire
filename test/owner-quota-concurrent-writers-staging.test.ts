import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';

interface Counts{
  reserved:number;
  duplicate:number;
  'daily-exhausted':number;
  other:string[];
}
async function exerciseConcurrentOwnerDb(numWorkers:number,perWorker:number){
  if(!Number.isSafeInteger(numWorkers)||numWorkers<2||numWorkers>8||
    !Number.isSafeInteger(perWorker)||perWorker<1||perWorker>50){
    throw new Error('S5 parallel DEV test limits exceeded');
  }
  const directory=mkdtempSync(path.join(tmpdir(),'nexowire-owner-concurrency-'));
  const dbFile=path.join(directory,'owner-concurrent.sqlite');
  const db=new DatabaseSync(dbFile);
  const workers:Worker[]=[];
  try{
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=30000;');
    for(const relative of [
      'test/fixtures/scale-v2-owner-shared-quota-dev.sql',
      'test/fixtures/scale-v2-all-ingress-transport-staging.sql',
    ])db.exec(readFileSync(path.resolve(relative),'utf8'));
    db.prepare('INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)')
      .run('benchmark-concurrency-account-0001','custom',100,1,1);
    db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
      .run('benchmark-concurrency-device-0001',
        'benchmark-concurrency-account-0001',1,'safe');
    const gate=new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const signal=new Int32Array(gate);
    const replies:Counts[]=[];
    let ready=0;
    let awake:()=>void=()=>{};
    const allReady=new Promise<void>(resolve=>{awake=resolve});
    const done:Promise<void>[]=[];
    for(let i=0;i<numWorkers;i++){
      const w=new Worker(
        new URL('./fixtures/s5-owner-quota-parallel-worker.ts',import.meta.url),{
          workerData:{
            sqlitePath:dbFile,workerIndex:i,
            uniqueAttempts:perWorker,barrier:gate,
          },
          execArgv:['--import','tsx'],
        });
      workers.push(w);
      done.push(new Promise<void>((resolve,reject)=>{
        let terminal=false;
        w.on('message',(msg:{
          kind:string;
          tally?:Counts;
          error?:string;
        })=>{
          if(msg.kind==='ready'){
            ready++;if(ready===numWorkers)awake();
          }else if(msg.kind==='done' && msg.tally){
            replies.push(msg.tally);
            terminal=true;
          }else if(msg.kind==='error'){
            reject(new Error('Worker failure: '+(msg.error??'unknown')));
          }
        });
        w.on('error',reject);
        w.on('exit',code=>{
          if(code===0&&terminal)resolve();
          else reject(new Error('S5 worker exited before completion, code '+code));
        });
      }));
    }
    let readyTimeout:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([
        allReady,
        new Promise<never>((_,reject)=>{
          readyTimeout=setTimeout(()=>
            reject(new Error('S5 workers did not all become ready')),15000);
        }),
      ]);
    }finally{
      if(readyTimeout)clearTimeout(readyTimeout);
    }
    const started=performance.now();
    Atomics.store(signal,0,1);
    Atomics.notify(signal,0,numWorkers);
    await Promise.all(done);
    const elapsedMs=performance.now()-started;
    const aggregate=replies.reduce<Counts>((acc,x)=>({
      reserved:acc.reserved+x.reserved,
      duplicate:acc.duplicate+x.duplicate,
      'daily-exhausted':acc['daily-exhausted']+x['daily-exhausted'],
      other:[...acc.other,...x.other],
    }),{reserved:0,duplicate:0,'daily-exhausted':0,other:[]});
    const used=Number((db.prepare(
      "SELECT used FROM proposed_owner_quota_daily "+
      "WHERE account_id='benchmark-concurrency-account-0001' "+
      "AND day_utc='2026-10-17'",
    ).get() as {used:number}|undefined)?.used??0);
    const unique=Number((db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_quota_invocations',
    ).get() as {n:number}).n);
    const expectedAccepted=Math.min(100,1+numWorkers*perWorker);
    assert.equal(replies.length,numWorkers);
    assert.deepEqual(aggregate.other,[]);
    assert.equal(aggregate.reserved,expectedAccepted);
    assert.equal(aggregate.duplicate,numWorkers-1);
    assert.equal(aggregate['daily-exhausted'],
      1+numWorkers*perWorker-expectedAccepted);
    assert.equal(used,expectedAccepted);
    assert.equal(unique,expectedAccepted);
    return {workers:numWorkers,uniquePerWorker:perWorker,
      elapsedMs:Number(elapsedMs.toFixed(2)),
      accepted:aggregate.reserved,duplicates:aggregate.duplicate,
      exhausted:aggregate['daily-exhausted'],
      dailyUsed:used,uniqueLedgerRows:unique};
  }finally{
    await Promise.allSettled(workers.map(w=>w.terminate()));
    db.close();
    rmSync(directory,{recursive:true,force:true});
  }
}

test('four real Worker threads race over one owner SQLite 100/day limit',
  {timeout:45000},async()=>{
  const r=await exerciseConcurrentOwnerDb(4,40);
  assert.equal(r.accepted,100);
  assert.equal(r.duplicates,3);
  assert.equal(r.exhausted,61);
  assert.equal(r.dailyUsed,100);
  assert.equal(r.uniqueLedgerRows,100);
});
test('six real Worker threads share one logical invocation and deny overflow',
  {timeout:45000},async()=>{
  const r=await exerciseConcurrentOwnerDb(6,20);
  assert.equal(r.accepted,100);
  assert.equal(r.duplicates,5);
  assert.equal(r.exhausted,21);
});
test('parallel local load harness rejects unsafe workload dimensions',async()=>{
  await assert.rejects(exerciseConcurrentOwnerDb(100,1));
  await assert.rejects(exerciseConcurrentOwnerDb(2,100000));
});
