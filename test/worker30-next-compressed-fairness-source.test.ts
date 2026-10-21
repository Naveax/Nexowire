/**
 * Worker30 NEXT: real proposed #598 Express middleware, localhost only.
 * Detect encoded/decoded response-accounting gap. Do not call this a
 * native MCP/tenant/WSS acceptance or a production security fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request, type ServerResponse} from 'node:http';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {
  createNexowireMcpExpressApp,NEXOWIRE_MCP_RESPONSE_BODY_LIMIT_BYTES,
} from '../src/mcp/http-app.js';
import {ProposedS5ProtectedTenantAdmission}
  from '../src/ops/scale-s5-protected-admission.js';

const HOST='127.0.0.1';
const BASE_SHA='cf58e6882e44968698f3f548b353287ba1698747';
const SEED=0x30ca5e21;
const SHA=createHash('sha256').update('worker30-next-local-queue-only').digest('hex');
const AT=new Date('2026-10-21T16:00:00.000Z');
type Principal='tenant-noisy-30'|'tenant-quiet-30';
type Sample={principal:Principal;status:number;latencyMs:number};
function shuffled<T>(input:readonly T[], seed:number):T[]{
  const a=[...input];
  let x=seed>>>0;
  function next():number{x^=x<<13;x^=x>>>17;x^=x<<5;return x>>>0;}
  for(let i=a.length-1;i>0;i--){
    const j=next()%(i+1);
    [a[i],a[j]]=[a[j]!,a[i]!];
  }
  return a;
}
function percentiles(samples:readonly number[]){
  if(!samples.length||samples.some(x=>!Number.isFinite(x)||x<0))
    throw Error('INVALID_LATENCY_SAMPLES');
  const a=[...samples].sort((x,y)=>x-y);
  const at=(p:number)=>a[Math.ceil(a.length*p)-1]!;
  return {n:a.length,unit:'ms',method:'nearest-rank',
    p50:+at(.5).toFixed(3),p95:+at(.95).toFixed(3),p99:+at(.99).toFixed(3)};
}
async function local(app:ReturnType<typeof createNexowireMcpExpressApp>){
  const server=createServer(app);
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,HOST,resolve);
  });
  const addr=server.address();
  assert.ok(addr&&typeof addr!=='string');
  return {server,port:addr.port,url:'http://'+HOST+':'+addr.port+'/mcp',
    close:async()=>{
      server.closeAllConnections();
      await new Promise<void>((resolve,reject)=>
        server.close(e=>e?reject(e):resolve()));
    }};
}

test('worker30-next: encoded MCP response limit is a WIRE cap, not an inflated-body cap',
  {timeout:30000},async()=>{
    const limit=NEXOWIRE_MCP_RESPONSE_BODY_LIMIT_BYTES;
    const expanded=JSON.stringify({payload:'e'.repeat(limit+1024)});
    const gzip=gzipSync(Buffer.from(expanded));
    assert.ok(gzip.byteLength<100*1024,'small compressed wire must demonstrate expansion');
    const app=createNexowireMcpExpressApp({host:HOST,allowedHosts:[HOST,'localhost']});
    app.post('/mcp',(_req,res)=>{
      res.setHeader('Content-Encoding','gzip');
      res.setHeader('Content-Type','application/json');
      res.end(gzip);
    });
    const h=await local(app);
    try{
      const response=await fetch(h.url,{method:'POST',
        headers:{'content-type':'application/json'},body:'{}',
        signal:AbortSignal.timeout(10_000)});
      assert.equal(response.status,200,
        'current source permits wire-bounded but decoded-oversized gzip response');
      const decoded=await response.text();
      assert.equal(Buffer.byteLength(decoded),Buffer.byteLength(expanded));
      assert.ok(Buffer.byteLength(decoded)>limit);
      // SOURCE GAP: upstream consumer can inflate past per-response wire budget.
      // This passing regression intentionally documents the gap; it is NOT a
      // desired production acceptance or claim of decoded-byte protection.
      process.stdout.write('QA30_NEXT_ENCODED_GAP '+JSON.stringify({
        baseSourceSha:BASE_SHA,workflowSha:process.env.GITHUB_SHA??null,
        seed:SEED,classification:'SOURCE_GAP_DECODED_RESPONSE_UNBOUNDED',
        wireBytes:gzip.byteLength,decodedBytes:Buffer.byteLength(decoded),
        wireLimitBytes:limit,providerWssConnections:0,
      })+'\n');
    }finally{await h.close();}
  });

test('worker30-next: over-limit compressed response wire gets 413 UNKNOWN; header mismatch is recorded',
  {timeout:30000},async()=>{
    const limit=NEXOWIRE_MCP_RESPONSE_BODY_LIMIT_BYTES;
    const pseudo=Buffer.allocUnsafe(1024*1024);
    let x=SEED;
    for(let i=0;i<pseudo.length;i++){
      x^=x<<13;x^=x>>>17;x^=x<<5;pseudo[i]=x&255;
    }
    const member=gzipSync(pseudo);
    const wire=Buffer.concat(Array.from({length:11},()=>member));
    assert.ok(wire.byteLength>limit,'fixed-seed compressed wire must exceed cap');
    const app=createNexowireMcpExpressApp({host:HOST,allowedHosts:[HOST,'localhost']});
    app.post('/mcp',(_req,res)=>{
      res.setHeader('Content-Encoding','gzip');
      res.setHeader('Content-Type','application/json');
      res.end(wire);
    });
    const h=await local(app);
    try{
      // Raw HTTP is essential: fetch would auto-decode the 413's stale gzip
      // Content-Encoding, obscuring the JSON UNKNOWN error provenance.
      const result=await new Promise<{code:number;encoding:string|null;body:string}>(
        (resolve,reject)=>{
          const req=request({hostname:HOST,port:h.port,path:'/mcp',method:'POST',
            headers:{'content-type':'application/json','content-length':'2'}},res=>{
              const chunks:Buffer[]=[];
              res.on('data',chunk=>chunks.push(Buffer.from(chunk)));
              res.on('end',()=>resolve({
                code:res.statusCode??0,
                encoding:typeof res.headers['content-encoding']==='string'
                  ?res.headers['content-encoding']:null,
                body:Buffer.concat(chunks).toString('utf8'),
              }));
              res.on('error',reject);
            });
          req.on('error',reject);
          req.end('{}');
        });
      assert.equal(result.code,413);
      const parsed=JSON.parse(result.body) as {
        code:string; mutation_state:string;automatically_retryable:boolean;
      };
      assert.equal(parsed.code,'MCP_RESPONSE_TOO_LARGE');
      assert.equal(parsed.mutation_state,'unknown');
      assert.equal(parsed.automatically_retryable,false);
      assert.equal(result.encoding,'gzip',
        'known source defect: 413 JSON retains gzip header despite plain JSON body');
      process.stdout.write('QA30_NEXT_RESPONSE_HEADER '+JSON.stringify({
        baseSourceSha:BASE_SHA,workflowSha:process.env.GITHUB_SHA??null,
        seed:SEED,classification:'SOURCE_GAP_STALE_CONTENT_ENCODING_ON_413',
        wireBytes:wire.byteLength,limitBytes:limit,httpStatus:result.code,
        automaticallyRetryable:false,
      })+'\n');
    }finally{await h.close();}
  });

test('worker30-next: 4 held large parsers, 64 seeded small POSTs, quiet tenant protected',
  {timeout:35000},async()=>{
    const db=new DatabaseSync(':memory:');
    db.exec(readFileSync(path.resolve('test/fixtures/s5-protected-share-local.sql'),'utf8'));
    const ledger=new ProposedS5ProtectedTenantAdmission(db,{
      scope:'scope-worker30-next-test-only',globalRollingMinuteLimit:40,
      tenants:[{tenantId:'tenant-noisy-30',weight:1},
        {tenantId:'tenant-quiet-30',weight:1}],
    });
    const app=createNexowireMcpExpressApp({host:HOST,allowedHosts:[HOST,'localhost']});
    app.post('/mcp',(req,res)=>{
      if(req.body?.recovered===true){res.json({recovered:true});return;}
      const who=req.headers['x-qa30-tenant'];
      if(who!=='tenant-noisy-30'&&who!=='tenant-quiet-30'){
        res.status(403).json({error:'NO_TEST_TENANT'});return;
      }
      // This deterministic fixture mapping is NOT authentication: real MCP
      // tenant binding must be supplied by a trusted auth adapter.
      const requestId=String(req.body?.id??'');
      const admission=ledger.observe(who,requestId,SHA,AT);
      assert.equal(admission.authorizesToolExecution,false);
      res.status(admission.status==='reserved'?200:429).json({
        status:admission.status,tenant:who,sourceOnly:true,
      });
    });
    const h=await local(app);
    const held:ReturnType<typeof request>[]=[];
    const heldResponses:ServerResponse[]=[];
    let arrivalCount=0;
    let arrivalsResolved:()=>void=()=>{};
    const arrived=new Promise<void>(resolve=>{arrivalsResolved=resolve;});
    h.server.on('request',(req,res)=>{
      if(req.headers['x-qa30-hold']==='yes'){
        heldResponses.push(res);
        if(++arrivalCount===4)arrivalsResolved();
      }
    });
    try{
      for(let i=0;i<4;i++){
        const req=request({host:HOST,port:h.port,path:'/mcp',method:'POST',
          headers:{'content-type':'application/json',
            'transfer-encoding':'chunked','x-qa30-hold':'yes'}});
        req.on('error',()=>{}); // intentionally interrupted synthetic upload
        held.push(req);
        req.write('{"payload":"held');
      }
      await arrived; // actual server requests, no sleep as concurrency proof
      assert.equal(heldResponses.length,4);

      const jobs=shuffled([
        ...Array.from({length:40},(_,i)=>({
          who:'tenant-noisy-30' as Principal,id:'worker30-noisy-'+i,
        })),
        ...Array.from({length:24},(_,i)=>({
          who:'tenant-quiet-30' as Principal,id:'worker30-quiet-'+i,
        })),
      ],SEED);
      const samples:Sample[]=[];
      let cursor=0;
      await Promise.all(Array.from({length:8},async()=>{
        while(cursor<jobs.length){
          const job=jobs[cursor++]!;
          const start=performance.now();
          const response=await fetch(h.url,{
            method:'POST',signal:AbortSignal.timeout(8000),
            headers:{'content-type':'application/json','x-qa30-tenant':job.who},
            body:JSON.stringify({id:job.id}),
          });
          const b=await response.json() as {status:string;tenant:Principal};
          assert.equal(b.tenant,job.who);
          assert.ok(response.status===200||response.status===429);
          assert.equal(b.status,response.status===200?'reserved':'tenant-exhausted');
          samples.push({principal:job.who,status:response.status,
            latencyMs:performance.now()-start});
        }
      }));
      assert.equal(samples.length,64);
      assert.equal(samples.filter(x=>x.status===200).length,40);
      const tenants=(['tenant-noisy-30','tenant-quiet-30'] as const);
      for(const who of tenants){
        assert.equal(samples.filter(x=>x.principal===who&&x.status===200).length,20);
      }
      const fifth=await fetch(h.url,{method:'POST',signal:AbortSignal.timeout(6000),
        headers:{'content-type':'application/json'},
        body:JSON.stringify({payload:'L'.repeat(221*1024)})});
      assert.equal(fifth.status,503);
      assert.equal((await fifth.json() as {code:string}).code,'MCP_JSON_PARSER_BUSY');
      const completed=heldResponses.map(res=>new Promise<void>(resolve=>
        res.once('close',resolve)));
      for(const req of held)req.destroy();
      await Promise.all(completed);
      const recovered=await fetch(h.url,{method:'POST',signal:AbortSignal.timeout(8000),
        headers:{'content-type':'application/json'},
        body:JSON.stringify({recovered:true,payload:'r'.repeat(221*1024)})});
      assert.equal(recovered.status,200);
      assert.equal((await recovered.json() as {recovered:boolean}).recovered,true);
      const success=samples.filter(x=>x.status===200);
      const rejected=samples.filter(x=>x.status===429);
      const metrics=percentiles(success.map(x=>x.latencyMs));
      const deniedMetrics=percentiles(rejected.map(x=>x.latencyMs));
      assert.ok(metrics.p99>=metrics.p95&&metrics.p95>=metrics.p50);
      assert.ok(deniedMetrics.p99>=deniedMetrics.p95);
      process.stdout.write('QA30_NEXT_FAIRNESS '+JSON.stringify({
        sourceBaseSha:BASE_SHA,workflowSha:process.env.GITHUB_SHA??null,
        seed:SEED,classification:'LOCAL_EXPRESS_AND_STAGING_LEDGER_ONLY',
        heldParserCount:4,smallAttempts:64,workers:8,
        perTenantSmallAdmitted:{noisy:20,quiet:20},
        rejected:24,fifthLargeHttpStatus:503,
        successLatency:metrics,rejectedLatency:deniedMetrics,
        timer:'performance.now request-start to response-body-consumed',
        nativeCompletions:0,authenticatedPublicWss:0,cloudflareMeter:null,
      })+'\n');
    }finally{
      for(const req of held)req.destroy();
      await h.close();
      db.close();
    }
  });
