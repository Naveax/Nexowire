/**
 * Independent #30 test: differentiate identity-framed quiet fast path from
 * globally throttled compressed and chunked quiet requests on real #598
 * Express source. Tenant headers are *untrusted test fixture inputs*.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request,type ClientRequest} from 'node:http';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createNexowireMcpExpressApp} from '../src/mcp/http-app.js';
import {ProposedS5ProtectedTenantAdmission}
  from '../src/ops/scale-s5-protected-admission.js';

const HOST='127.0.0.1';
const SEED=0x30ca5e21;
const BASE_SHA='8b08ede8db29fd9a95abb762b238601def07082d';
const PARSER_SHA='cf58e6882e44968698f3f548b353287ba1698747';
const NOISY='worker30-noisy-tenant',QUIET='worker30-quiet-tenant';
const AT=new Date('2026-10-21T19:00:00.000Z');
const FP=createHash('sha256').update('worker30-pending-gzip-source-isolation').digest('hex');
type Tenant=typeof NOISY|typeof QUIET;
type Observation={tenant:Tenant;status:number;durationMs:number};
function shuffle<T>(values:readonly T[],seed:number):T[]{
  const a=[...values];let x=seed>>>0;
  for(let i=a.length-1;i>0;i--){
    x^=x<<13;x^=x>>>17;x^=x<<5;
    const j=(x>>>0)%(i+1);
    [a[i],a[j]]=[a[j]!,a[i]!];
  }
  return a;
}
function quantiles(values:readonly number[]){
  if(!values.length||values.some(x=>!Number.isFinite(x)||x<0))
    throw Error('QA30_INVALID_LATENCY_SAMPLE');
  const ordered=[...values].sort((a,b)=>a-b);
  const at=(p:number)=>Number(ordered[Math.ceil(p*ordered.length)-1]!.toFixed(3));
  return {n:ordered.length,unit:'ms' as const,method:'nearest-rank' as const,
    p50:at(.5),p95:at(.95),p99:at(.99)};
}
async function rawChunkedTiny(port:number,body:string){
  return new Promise<{status:number;code:string}>((resolve,reject)=>{
    const req=request({host:HOST,port,path:'/mcp',method:'POST',
      headers:{'content-type':'application/json',
        'transfer-encoding':'chunked','x-qa30-tenant':QUIET}},res=>{
      const chunks:Buffer[]=[];
      res.on('data',part=>chunks.push(Buffer.from(part)));
      res.on('end',()=>{
        try{
          const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {code:string};
          resolve({status:res.statusCode??0,code:body.code});
        }catch(error){reject(error)}
      });
      res.on('error',reject);
    });
    req.on('error',reject);
    req.end(body);
  });
}
test('QA30 real parser: four noisy partial gzip slots protect framed quiet but reject encoded/unknown-length quiet',
  {timeout:40000},async()=>{
    const fixture=new DatabaseSync(':memory:');
    fixture.exec(readFileSync(path.resolve('test/fixtures/s5-protected-share-local.sql'),'utf8'));
    const fair=new ProposedS5ProtectedTenantAdmission(fixture,{
      scope:'worker30-compression-gap-admission',globalRollingMinuteLimit:48,
      tenants:[{tenantId:NOISY,weight:1},{tenantId:QUIET,weight:1}],
    });
    const app=createNexowireMcpExpressApp({host:HOST,allowedHosts:[HOST,'localhost']});
    let handlerRuns=0;
    app.post('/mcp',(req,res)=>{
      handlerRuns++;
      if(req.body?.recovered===true){
        res.json({recovered:true});return;
      }
      const who=req.headers['x-qa30-tenant'];
      if(who!==NOISY&&who!==QUIET){res.status(403).json({code:'UNTRUSTED_FIXTURE'});return}
      const id=typeof req.body?.id==='string'?req.body.id:'';
      const d=fair.observe(who,id,FP,AT);
      assert.equal(d.authorizesToolExecution,false);
      res.status(d.status==='reserved'?200:429)
        .json({status:d.status,tenant:who});
    });
    const server=createServer(app);
    let seen=0;
    let arrived!:()=>void;
    const seenFour=new Promise<void>(resolve=>{arrived=resolve;});
    const closeEvents:Promise<void>[]=[];
    server.on('request',(req,res)=>{
      if(req.headers['x-qa30-held']==='noisy-gzip'){
        closeEvents.push(new Promise<void>(resolve=>res.once('close',resolve)));
        if(++seen===4)arrived();
      }
    });
    const held:ClientRequest[]=[];
    let listening=false;
    try{
      await new Promise<void>((resolve,reject)=>{
        server.once('error',reject);
        server.listen(0,HOST,resolve);
      });
      listening=true;
      const address=server.address();
      assert.ok(address&&typeof address!=='string');
      const url='http://'+HOST+':'+address.port+'/mcp';
      const compressed=gzipSync(Buffer.from(JSON.stringify({
        payload:'N'.repeat(1024*1024),
      })));
      assert.ok(compressed.byteLength<100*1024);
      const partial=compressed.subarray(0,Math.floor(compressed.byteLength/2));
      for(let i=0;i<4;i++){
        const client=request({host:HOST,port:address.port,path:'/mcp',
          method:'POST',headers:{'content-type':'application/json',
            'content-encoding':'gzip','content-length':String(compressed.byteLength),
            'x-qa30-held':'noisy-gzip','x-qa30-tenant':NOISY}});
        client.on('error',()=>{}); // only from intentional close of test clients
        held.push(client);
        client.write(partial);
      }
      await seenFour; // server arrival barrier; not a sleep-based race
      assert.equal(seen,4);
      const directGzip=await fetch(url,{method:'POST',
        headers:{'content-type':'application/json','content-encoding':'gzip',
          'x-qa30-tenant':QUIET},body:new Uint8Array(gzipSync(
            Buffer.from(JSON.stringify({id:'quiet-encoded-not-charged'})))),
        signal:AbortSignal.timeout(6000)});
      assert.equal(directGzip.status,503);
      assert.equal((await directGzip.json() as {code:string}).code,'MCP_JSON_PARSER_BUSY');
      const chunked=await rawChunkedTiny(address.port,JSON.stringify({
        id:'quiet-unknown-length-not-charged',
      }));
      assert.deepEqual(chunked,{status:503,code:'MCP_JSON_PARSER_BUSY'});
      assert.equal(handlerRuns,0,
        'busy gzip and chunked requests never invoke test-only tenant ledger');
      const jobs=shuffle([
        ...Array.from({length:40},(_,i)=>({
          tenant:NOISY as Tenant,id:'worker30-noisy-'+String(i).padStart(3,'0'),
        })),
        ...Array.from({length:20},(_,i)=>({
          tenant:QUIET as Tenant,id:'worker30-quiet-'+String(i).padStart(3,'0'),
        })),
      ],SEED);
      let cursor=0;
      const samples:Observation[]=[];
      await Promise.all(Array.from({length:8},async()=>{
        while(cursor<jobs.length){
          const j=jobs[cursor++]!;
          const start=performance.now();
          const response=await fetch(url,{method:'POST',
            headers:{'content-type':'application/json','x-qa30-tenant':j.tenant},
            signal:AbortSignal.timeout(8000),body:JSON.stringify({id:j.id})});
          const body=await response.json() as {status:string;tenant:Tenant};
          assert.equal(body.tenant,j.tenant);
          assert.equal(body.status,response.status===200?'reserved':'tenant-exhausted');
          samples.push({tenant:j.tenant,status:response.status,
            durationMs:performance.now()-start});
        }
      }));
      assert.equal(samples.length,60);
      assert.equal(samples.filter(x=>x.tenant===QUIET&&x.status===200).length,20);
      assert.equal(samples.filter(x=>x.tenant===NOISY&&x.status===200).length,24);
      assert.equal(samples.filter(x=>x.tenant===NOISY&&x.status===429).length,16);
      assert.equal(samples.filter(x=>x.tenant===QUIET&&x.status!==200).length,0);
      const strictRows=(fixture.prepare(
        'SELECT COUNT(*) AS n FROM s5_fair_window'
      ).get() as {n:number}).n;
      assert.equal(strictRows,44);
      const handlerBeforeCancel=handlerRuns;
      const closes=[...closeEvents];
      for(const client of held)client.destroy();
      await Promise.all(closes);
      // Now a previously rejected *compressed* quiet tiny POST can enter the
      // parser, and reserves a legitimate quiet share in our fixture ledger.
      const recovered=await fetch(url,{method:'POST',
        headers:{'content-type':'application/json','content-encoding':'gzip',
          'x-qa30-tenant':QUIET},
        signal:AbortSignal.timeout(8000),
        body:new Uint8Array(gzipSync(
          Buffer.from(JSON.stringify({id:'quiet-encoded-after-release'})))),
      });
      assert.equal(recovered.status,200);
      const rec=await recovered.json() as {status:string;tenant:Tenant};
      assert.deepEqual(rec,{status:'reserved',tenant:QUIET});
      assert.equal(handlerRuns,handlerBeforeCancel+1);
      const qs=quantiles(samples.filter(x=>x.tenant===QUIET&&x.status===200)
        .map(x=>x.durationMs));
      const ns=quantiles(samples.filter(x=>x.tenant===NOISY&&x.status===200)
        .map(x=>x.durationMs));
      const denied=quantiles(samples.filter(x=>x.status===429).map(x=>x.durationMs));
      assert.equal(qs.n,20);assert.equal(ns.n,24);assert.equal(denied.n,16);
      assert.ok(qs.p99>=qs.p95&&ns.p99>=ns.p95);
      process.stdout.write('QA30_QUIET_GZIP_ISOLATION '+JSON.stringify({
        parentQaHeadSha:BASE_SHA,parserOwnerSourceSha:PARSER_SHA,
        workflowCheckoutSha:process.env.GITHUB_SHA??null,
        fixedSeed:SEED,classification:'LOCAL_PARSER_GLOBAL_GZIP_SLOT_NEGATIVE',
        noisyHeldPartialGzip:4,quietEncodedTinyWhileHeld:503,
        quietChunkedTinyWhileHeld:503,quietFramedIdentityAccepted:20,
        noisyIdentityAccepted:24,noisyIdentityDenied:16,
        quietEncodedAfterParserRelease:200,
        quietAcceptedLatency:qs,noisyAcceptedLatency:ns,
        deniedLatency:denied,latencyClock:'performance.now start to body consumed',
        headerIsAuthenticated:false,physicalPublicWss:0,
        nativeTransferBytes:0,paidCloudflareCost:null,
        productionTenantFairness:'NOT_PROVEN',
      })+'\n');
    }finally{
      for(const client of held)client.destroy();
      if(listening){
        server.closeAllConnections();
        await new Promise<void>((resolve,reject)=>
          server.close(error=>error?reject(error):resolve()));
      }
      fixture.close();
    }
  });
