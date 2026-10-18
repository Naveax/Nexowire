/**
 * S5 local SQLite concurrency proof. Exercises canonical ProposedAllIngressTransportMeter
 * across 4 real independent worker threads and durable WAL/SQLite transactions.
 * No network calls, no real provider enforcement and no production quota writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {ProposedAllIngressTransportMeter} from '../src/mcp/all-ingress-transport-meter-proposal.js';

type Tally={admitted:number;denied:number;retryMin:number;retryMax:number};
async function raceIngress(workersCount=4,attemptsEach=155,limit=600){
  if(!Number.isSafeInteger(workersCount)||workersCount<2||workersCount>4||
    !Number.isSafeInteger(attemptsEach)||attemptsEach<1||attemptsEach>155||
    !Number.isSafeInteger(limit)||limit<1||limit>600)throw new Error('Unsafe S5 race bounds');
  const folder=mkdtempSync(path.join(tmpdir(),'nexowire-s5-provider-race-'));
  const databasePath=path.join(folder,'ingress.sqlite');
  const db=new DatabaseSync(databasePath);
  const workers:Worker[]=[];
  try{
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=30000');
    db.exec(readFileSync(path.resolve('test/fixtures/scale-v2-all-ingress-transport-staging.sql'),'utf8'));
    const barrier=new SharedArrayBuffer(4);
    const signal=new Int32Array(barrier);
    const atUtc='2026-10-18T12:00:00.000Z';
    let ready=0,releaseReady=()=>{};
    const allReady=new Promise<void>(resolve=>{releaseReady=resolve});
    const tallies:Tally[]=[];
    const workerFinished:Array<Promise<void>>=[];
    for(let i=0;i<workersCount;i++){
      const w=new Worker(new URL('./fixtures/s5-ingress-parallel-worker.ts',import.meta.url),{
        workerData:{databasePath,workerIndex:i,attempts:attemptsEach,
          windowLimit:limit,barrier,atUtc},execArgv:['--import','tsx'],
      });
      workers.push(w);
      workerFinished.push(new Promise<void>((resolve,reject)=>{
        let terminal=false;
        w.on('message',(msg:{kind:string;workerIndex:number;message?:string}&Partial<Tally>)=>{
          if(msg.kind==='ready'){ready++;if(ready===workersCount)releaseReady()}
          else if(msg.kind==='done'){
            if(terminal)return reject(new Error('Duplicate result'));
            terminal=true;
            tallies.push({admitted:msg.admitted!,denied:msg.denied!,
              retryMin:msg.retryMin!,retryMax:msg.retryMax!});
          } else if(msg.kind==='failure')reject(new Error('Concurrent worker: '+msg.message));
        });
        w.on('error',reject);
        w.on('exit',code=>terminal&&code===0?resolve():reject(new Error('Worker exit '+code)));
      }));
    }
    let readyTimer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([allReady,new Promise<never>((_,reject)=>{
        readyTimer=setTimeout(()=>reject(new Error('Worker startup exceeded 15 sec')),15000);
      })]);
    }finally{if(readyTimer)clearTimeout(readyTimer)}
    const started=performance.now();
    Atomics.store(signal,0,1);
    Atomics.notify(signal,0,workersCount);
    await Promise.all(workerFinished);
    const elapsedMs=Number((performance.now()-started).toFixed(2));
    const accepted=tallies.reduce((n,r)=>n+r.admitted,0);
    const denied=tallies.reduce((n,r)=>n+r.denied,0);
    const totals=db.prepare('SELECT observed,admitted,rejected FROM proposed_ingress_transport_totals WHERE scope_id=?')
      .get('trusted-s5-shared-provider-scope') as {observed:number;admitted:number;rejected:number};
    const rows=(db.prepare('SELECT COUNT(*) AS n FROM proposed_ingress_transport_admissions').get() as {n:number}).n;
    assert.equal(accepted,Math.min(limit,workersCount*attemptsEach));
    assert.equal(denied,workersCount*attemptsEach-accepted);
    assert.equal(totals.observed,workersCount*attemptsEach);
    assert.equal(totals.admitted,accepted);
    assert.equal(totals.rejected,denied);
    assert.equal(rows,accepted);
    if(denied)assert.ok(tallies.filter(x=>x.denied).every(x=>x.retryMin===60000&&x.retryMax===60000));
    const meter=new ProposedAllIngressTransportMeter(db,limit);
    assert.equal(meter.observe('another-trusted-independent-scope',new Date(atUtc)).allowed,true);
    assert.equal(meter.observe('trusted-s5-shared-provider-scope',new Date('2026-10-18T12:01:00.001Z')).allowed,true);
    return {workersCount,attempted:workersCount*attemptsEach,accepted,denied,
      observed:totals.observed,rows,elapsedMs};
  }finally{
    await Promise.allSettled(workers.map(w=>w.terminate()));
    db.close();rmSync(folder,{recursive:true,force:true});
  }
}
test('S5 4 real SQLite writers enforce a single 600 per rolling-minute provider scope',
  {timeout:100000},async()=>{
    const result=await raceIngress();
    assert.equal(result.attempted,620);
    assert.equal(result.accepted,600);
    assert.equal(result.denied,20);
    assert.equal(result.rows,600);
  });
test('S5 4 writers fail closed at a lower 64/rolling-minute owner setting',
  {timeout:100000},async()=>{
    const result=await raceIngress(4,24,64);
    assert.equal(result.accepted,64);
    assert.equal(result.denied,32);
    assert.equal(result.rows,64);
  });
test('S5 rejects unsafe parallel workload dimensions',async()=>{
  await assert.rejects(raceIngress(20,1,600));
  await assert.rejects(raceIngress(4,156,600));
  await assert.rejects(raceIngress(4,24,601));
});
test('S5 global shared 600 budget does NOT itself guarantee per-tenant fairness',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(readFileSync(path.resolve('test/fixtures/scale-v2-all-ingress-transport-staging.sql'),'utf8'));
    const meter=new ProposedAllIngressTransportMeter(db,600);
    const now=new Date('2026-10-18T12:00:00.000Z');
    for(let i=0;i<600;i++)assert.equal(meter.observe('shared-all-tenants-scope',now).allowed,true);
    // 600 request slots exhausted by a single noisy principal upstream.
    const quietTenant=meter.observe('shared-all-tenants-scope',now);
    assert.equal(quietTenant.allowed,false);
    assert.equal(quietTenant.retryAfterMs,60000);
    // Critical: this is a NEGATIVE fairness proof, not a fairness acceptance test.
  }finally{db.close()}
});
