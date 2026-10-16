import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer,request as httpRequest,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {
  ProposedAllIngressTransportMeter,
  verifyIngressMinuteLimit,
} from '../src/mcp/all-ingress-transport-meter-proposal.js';
import {createLocalFirstIngressServer,validateLocalFirstIngress}
  from '../src/mcp/local-first-ingress.js';

const t0=new Date('2026-10-16T17:00:00.000Z');
const scope='tunnel-verified-app-alpha';
const bearer='Bearer test-safe-token-longer-than-16';
function f(limit=600){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(path.join(process.cwd(),
    'test/fixtures/scale-v2-all-ingress-transport-staging.sql'),'utf8'));
  const meter=new ProposedAllIngressTransportMeter(db,limit);
  const at={value:t0};
  const send=(s=scope,time=at.value)=>meter.observe(s,time);
  const totals=(s=scope)=>{
    const row=db.prepare(
      'SELECT observed,admitted,rejected FROM proposed_ingress_transport_totals '+
      'WHERE scope_id=?',
    ).get(s) as {observed:number,admitted:number,rejected:number}|undefined;
    return row ? {observed:row.observed,admitted:row.admitted,rejected:row.rejected}
      : undefined;
  };
  return {db,meter,at,send,totals,close:()=>db.close()};
}
async function listen(server:Server):Promise<number>{
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      server.off('error',reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}
async function stop(server:Server):Promise<void>{
  server.closeAllConnections();
  await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
}
async function ingressFixture(limit=5){
  const x=f(limit);
  const calls:string[]=[];
  const hub=createServer((req,res)=>{
    calls.push(req.method+' '+req.url);
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({received:req.url}));
  });
  const hubPort=await listen(hub);
  const origin=createLocalFirstIngressServer({
    hubPort,listenPort:43111,
    stagingTransportBudget:{
      trustedScope:scope,meter:x.meter,clock:()=>x.at.value,
    },
  });
  const port=await listen(origin);
  const root='http://127.0.0.1:'+port;
  return {...x,calls,root,origin,hub,async done(){
    await stop(origin);await stop(hub);x.close();
  }};
}
test('budget is never permitted above provider default 600/min, supports stricter local cap',()=>{
  for(const x of [1,3,600])assert.equal(verifyIngressMinuteLimit(x),x);
  for(const x of [0,-1,601,1000,Number.MAX_SAFE_INTEGER,NaN,1.2]){
    assert.throws(()=>verifyIngressMinuteLimit(x));
  }
});
test('600 arrivals admitted, 601th 429 locally; full count includes overflow',()=>{
  const x=f();try{
    for(let i=0;i<600;i++)assert.equal(x.send().allowed,true);
    const rejected=x.send();
    assert.equal(rejected.allowed,false);
    assert.equal(rejected.observedTotal,601);
    assert.equal(rejected.admittedTotal,600);
    assert.equal(rejected.rejectedTotal,1);
    assert.equal(rejected.admittedRollingMinute,600);
    assert.equal(rejected.retryAfterMs,60000);
    assert.deepEqual(x.totals(),{observed:601,admitted:600,rejected:1});
  }finally{x.close()}
});
test('exact rolling 60 sec resets only when first accepted sample expires',()=>{
  const x=f(2);try{
    const start=x.send();
    assert.equal(start.allowed,true);
    assert.equal(x.send(scope,new Date(t0.getTime()+1)).allowed,true);
    let rejected=x.send(scope,new Date(t0.getTime()+59999));
    assert.equal(rejected.allowed,false);
    assert.equal(rejected.retryAfterMs,1);
    const next=x.send(scope,new Date(t0.getTime()+60000));
    assert.equal(next.allowed,true);
    assert.equal(next.admittedRollingMinute,2);
    assert.deepEqual(x.totals(),{observed:4,admitted:3,rejected:1});
  }finally{x.close()}
});
test('boundary at UTC midnight does not reset shared 60-second budget',()=>{
  const x=f(1);try{
    const before=new Date('2026-10-16T23:59:59.900Z');
    assert.equal(x.send(scope,before).allowed,true);
    assert.equal(x.send(scope,new Date('2026-10-17T00:00:00.100Z')).allowed,false);
    assert.equal(x.send(scope,new Date(before.getTime()+60000)).allowed,true);
  }finally{x.close()}
});
test('replayed, unauthenticated and discovery requests each consume ingress arrival budget',()=>{
  const x=f(3);try{
    for(const id of ['same-invocation','same-invocation','metadata-call']){
      void id;
      assert.equal(x.send().allowed,true);
    }
    assert.equal(x.send().allowed,false);
    assert.deepEqual(x.totals(),{observed:4,admitted:3,rejected:1});
  }finally{x.close()}
});
test('trust scope shared across customers; distinct REAL authenticated tunnel app scopes separate',()=>{
  const x=f(2);try{
    assert.equal(x.send().allowed,true);
    assert.equal(x.send().allowed,true);
    assert.equal(x.send().allowed,false);
    const other='tunnel-verified-app-beta';
    assert.equal(x.send(other).allowed,true);
    assert.deepEqual(x.totals(),{observed:3,admitted:2,rejected:1});
    assert.deepEqual(x.totals(other),{observed:1,admitted:1,rejected:0});
  }finally{x.close()}
});
test('two meter objects on SAME trusted DB share one counter and cannot double-admit',()=>{
  const x=f(1);try{
    const meter2=new ProposedAllIngressTransportMeter(x.db,1);
    assert.equal(x.send().allowed,true);
    assert.equal(meter2.observe(scope,t0).allowed,false);
    assert.equal(x.totals()?.admitted,1);
  }finally{x.close()}
});
test('two independent owner-hosted SQLite connections share the same durable scope',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'nexowire-ingress-'));
  const filename=path.join(dir,'budget.sqlite3');
  const a=new DatabaseSync(filename);
  const b=new DatabaseSync(filename);
  try{
    a.exec(readFileSync(path.join(process.cwd(),
      'test/fixtures/scale-v2-all-ingress-transport-staging.sql'),'utf8'));
    const one=new ProposedAllIngressTransportMeter(a,1);
    const two=new ProposedAllIngressTransportMeter(b,1);
    assert.equal(one.observe(scope,t0).allowed,true);
    assert.equal(two.observe(scope,t0).allowed,false);
    assert.equal((b.prepare('SELECT observed AS n FROM proposed_ingress_transport_totals')
      .get() as {n:number}).n,2);
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true})}
});
test('clock rollback and malformed trusted scope fail closed without mutating counters',()=>{
  const x=f(2);try{
    x.send();
    assert.throws(()=>x.send(scope,new Date(t0.getTime()-1)),/clock moved backward/);
    for(const invalid of ['','short','../path','evil user','a'.repeat(129)]){
      assert.throws(()=>x.send(invalid));
    }
    assert.deepEqual(x.totals(),{observed:1,admitted:1,rejected:0});
  }finally{x.close()}
});
test('missing or faulty SQLite schema never returns permission to forward',()=>{
  const db=new DatabaseSync(':memory:');try{
    assert.throws(()=>new ProposedAllIngressTransportMeter(db).observe(scope,t0),
      /no such table/);
  }finally{db.close()}
});
test('HTTP staging hook counts metadata, missing bearer, denied route and successful POST',async()=>{
  const x=await ingressFixture(4);try{
    const a=await fetch(x.root+'/mcp',{method:'POST',body:'{}'});
    assert.equal(a.status,401);
    const b=await fetch(x.root+'/.well-known/oauth-protected-resource/mcp');
    assert.equal(b.status,200);
    const c=await fetch(x.root+'/admin',{method:'POST'});
    assert.equal(c.status,404);
    const v=await fetch(x.root+'/mcp',{
      method:'POST',headers:{authorization:bearer},body:'{}',
    });
    assert.equal(v.status,200);
    const limit=await fetch(x.root+'/mcp',{
      method:'POST',headers:{authorization:bearer},body:'{}',
    });
    assert.equal(limit.status,429);
    assert.equal(limit.headers.get('retry-after'),'60');
    assert.deepEqual(x.calls,['GET /.well-known/oauth-protected-resource/mcp','POST /mcp']);
    assert.deepEqual(x.totals(),{observed:5,admitted:4,rejected:1});
  }finally{await x.done()}
});
test('malicious X-Forwarded headers cannot invent a second scope or reset provider budget',async()=>{
  const x=await ingressFixture(2);try{
    for(const fake of ['spoof-one','spoof-two']){
      const res=await fetch(x.root+'/mcp',{
        method:'POST',headers:{authorization:bearer,'x-forwarded-for':fake,
          'x-tunnel-id':'different-'+fake,'x-calling-application':'third-party'},
        body:'{}',
      });
      assert.equal(res.status,200);
    }
    const blocked=await fetch(x.root+'/mcp',{
      method:'POST',headers:{authorization:bearer,'x-tunnel-id':'new'},
      body:'{}',
    });
    assert.equal(blocked.status,429);
    assert.equal(x.totals()?.observed,3);
    assert.equal(x.db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_ingress_transport_totals',
    ).get()!.n,1);
  }finally{await x.done()}
});
test('staging hook rejects ALL requests 503 if trusted ingress DB unavailable',async()=>{
  const x=await ingressFixture(2);try{
    x.db.exec('DROP TABLE proposed_ingress_transport_clock');
    const response=await fetch(x.root+'/.well-known/oauth-protected-resource/mcp');
    assert.equal(response.status,503);
    assert.deepEqual(await response.json(),{error:'ingress_transport_meter_unavailable'});
    assert.equal(x.calls.length,0);
  }finally{await x.done()}
});
test('sanitized options preserve explicitly injected STAGING budget only',()=>{
  const x=f(1);try{
    const budget={trustedScope:scope,meter:x.meter,clock:()=>t0};
    const validated=validateLocalFirstIngress({
      hubPort:43110,listenPort:43111,stagingTransportBudget:budget,
    });
    assert.equal(validated.stagingTransportBudget,budget);
    assert.equal(validateLocalFirstIngress({hubPort:43110,listenPort:43111})
      .stagingTransportBudget,undefined);
  }finally{x.close()}
});
test('even denied WebSocket upgrade attempt is observed but never forwarded',async()=>{
  const x=await ingressFixture(2);try{
    await new Promise<void>((resolve,reject)=>{
      const req=httpRequest(x.root+'/agent',{
        headers:{connection:'Upgrade',upgrade:'websocket'},
      });
      req.once('error',()=>resolve());
      req.once('upgrade',(_response,socket)=>{
        socket.destroy();resolve();
      });
      req.once('response',response=>{
        response.resume();response.once('end',()=>resolve());
      });
      req.once('timeout',()=>reject(new Error('upgrade not terminated')));
      req.setTimeout(2000);
      req.end();
    });
    assert.deepEqual(x.totals(),{observed:1,admitted:1,rejected:0});
    assert.equal(x.calls.length,0);
  }finally{await x.done()}
});
test('without opt-in hook original localhost MCP behavior remains unchanged',async()=>{
  const hub=createServer((_req,res)=>res.end('pong'));
  const hubPort=await listen(hub);
  const origin=createLocalFirstIngressServer({hubPort,listenPort:43111});
  const port=await listen(origin);
  try{
    const response=await fetch('http://127.0.0.1:'+port+'/mcp',{
      method:'POST',headers:{authorization:bearer},body:'{}',
    });
    assert.equal(response.status,200);
    assert.equal(await response.text(),'pong');
  }finally{await stop(origin);await stop(hub)}
});
