import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ProposedS5ProtectedTenantAdmission} from '../src/ops/scale-s5-protected-admission.js';
test('S5 four independent SQLite writers cannot steal a late quiet tenant share',
  {timeout:45000},async()=>{
    const tmp=mkdtempSync(path.join(tmpdir(),'nexowire-s5-protected-race-'));
    const dbPath=path.join(tmp,'fair.sqlite');
    const db=new DatabaseSync(dbPath);
    const workers:Worker[]=[];
    try{
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=15000');
      db.exec(readFileSync(path.resolve('test/fixtures/s5-protected-share-local.sql'),'utf8'));
      // Two noisy workers do 60 attempts each, two quiet workers do 20 each.
      const config=[
        {tenantId:'trusted-account-a1',attempts:60},
        {tenantId:'trusted-account-a1',attempts:60},
        {tenantId:'trusted-account-b2',attempts:20},
        {tenantId:'trusted-account-b2',attempts:20},
      ];
      const signal=new Int32Array(new SharedArrayBuffer(4));
      let ready=0;
      let release=()=>{};
      const allReady=new Promise<void>(resolve=>{release=resolve});
      const rows:Array<{accepted:number;tenantDenied:number;other:number}>=[];
      const promises=config.map((c,i)=>{
        const w=new Worker(new URL('./fixtures/s5-protected-parallel-worker.ts',import.meta.url),{
          workerData:{dbPath,tenantId:c.tenantId,workerId:i,attempts:c.attempts,
            barrier:signal.buffer},execArgv:['--import','tsx'],
        });
        workers.push(w);
        return new Promise<void>((resolve,reject)=>{
          let gotTerminal=false;
          w.on('message',(msg:{kind:string;accepted:number;tenantDenied:number;other:number;message?:string})=>{
            if(msg.kind==='ready'){ready++;if(ready===4)release()}
            if(msg.kind==='error')reject(new Error(msg.message));
            if(msg.kind==='done'){gotTerminal=true;rows.push(msg)}
          });
          w.on('error',reject);
          w.on('exit',code=>gotTerminal&&code===0?resolve():reject(new Error('Worker did not complete '+code)));
        });
      });
      let handle:ReturnType<typeof setTimeout>|undefined;
      try{
        await Promise.race([allReady,new Promise<never>((_,reject)=>{
          handle=setTimeout(()=>reject(new Error('Workers not ready')),10000);
        })]);
      }finally{if(handle)clearTimeout(handle)}
      Atomics.store(signal,0,1);Atomics.notify(signal,0,4);
      await Promise.all(promises);
      const counts=db.prepare('SELECT tenant_id,COUNT(*) AS n FROM s5_fair_window GROUP BY tenant_id ORDER BY tenant_id')
        .all() as Array<{tenant_id:string;n:number}>;
      assert.deepEqual(counts.map(c=>c.n),[50,40]);
      assert.equal(rows.reduce((a,c)=>a+c.accepted,0),90);
      assert.equal(rows.reduce((a,c)=>a+c.tenantDenied,0),70);
      assert.equal(rows.reduce((a,c)=>a+c.other,0),0);
      const ledger=(db.prepare('SELECT COUNT(*) AS n FROM s5_fair_invocations').get() as {n:number}).n;
      assert.equal(ledger,90);
    }finally{
      await Promise.allSettled(workers.map(w=>w.terminate()));
      db.close();rmSync(tmp,{recursive:true,force:true});
    }
  });
test('S5 mismatched operator share policy on shared DB fails closed',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(readFileSync(path.resolve('test/fixtures/s5-protected-share-local.sql'),'utf8'));
    const config=(a:number,b:number)=>({scope:'trusted-staging-scope',
      globalRollingMinuteLimit:100,tenants:[
        {tenantId:'trusted-account-a1',weight:a},
        {tenantId:'trusted-account-b2',weight:b},
      ]});
    const original=new ProposedS5ProtectedTenantAdmission(db,config(1,1));
    const changed=new ProposedS5ProtectedTenantAdmission(db,config(3,1));
    const sha='a'.repeat(64);
    const now=new Date('2026-10-18T12:00:00Z');
    assert.equal(original.observe('trusted-account-a1','fair-first-invocation-0001',sha,now).status,'reserved');
    assert.throws(()=>changed.observe('trusted-account-a1','fair-second-invocation-0002',sha,now),
      /policy mismatch/);
    assert.equal(original.observe('trusted-account-b2','fair-third-invocation-0003',sha,now).status,'reserved');
  }finally{db.close()}
});
