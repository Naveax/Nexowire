/**
 * Worker #30: real #598 proposed Express gzip parser admission at the full
 * 9.5 MiB decoded JSON boundary. All traffic is strictly 127.0.0.1.
 * The tenant split is a separately wired TEST-ONLY staging ledger, not auth.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer,request,type ClientRequest} from 'node:http';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {
  createNexowireMcpExpressApp,NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES,
} from '../src/mcp/http-app.js';
import {ProposedS5ProtectedTenantAdmission}
  from '../src/ops/scale-s5-protected-admission.js';

const HOST='127.0.0.1';
const SEED=0x30ca5e21;
const PARSER_BASE_SHA='cf58e6882e44968698f3f548b353287ba1698747';
const PARENT_QA_SHA='554528df1dd2be0c265571ac8a1233fade78da13';
const A='qa30-tenant-noisy';
const B='qa30-tenant-quiet';
const TIME=new Date('2026-10-21T17:00:00.000Z');
const REQUEST_SHA=createHash('sha256').update('qa30-source-only-strict-share').digest('hex');
type ResponseSummary={status:number;json:Record<string,unknown>};
type Sample={tenant:typeof A|typeof B;status:number;latencyMs:number};
function shuffle<T>(items:readonly T[],seed:number):T[]{
  const a=[...items];let x=seed>>>0;
  for(let i=a.length-1;i>0;i--){
    x^=x<<13;x^=x>>>17;x^=x<<5;
    const j=(x>>>0)%(i+1);
    [a[i],a[j]]=[a[j]!,a[i]!];
  }
  return a;
}
function nearestRank(xs:readonly number[]){
  if(!xs.length||xs.some(x=>!Number.isFinite(x)||x<0))
    throw Error('NO_VALID_LATENCY');
  const a=[...xs].sort((x,y)=>x-y);
  const get=(p:number)=>Number(a[Math.ceil(a.length*p)-1]!.toFixed(3));
  return {n:a.length,method:'nearest-rank',unit:'ms',
    p50:get(.5),p95:get(.95),p99:get(.99)};
}
async function post(url:string,headers:Record<string,string>,body:string|Uint8Array){
  const t=performance.now();
  const res=await fetch(url,{method:'POST',signal:AbortSignal.timeout(20000),
    headers:{'content-type':'application/json',...headers},
    body:typeof body==='string'?body:new Uint8Array(body)});
  const json=await res.json() as Record<string,unknown>;
  return {status:res.status,json,latencyMs:performance.now()-t};
}
test('QA30 full-boundary four concurrent gzip parsers protect tiny quiet-tenant admission',
  {timeout:120000},async()=>{
    const bound=NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES;
    const framingBytes=Buffer.byteLength(JSON.stringify({payload:''}));
    const decoded=Buffer.from(JSON.stringify({
      payload:'Q'.repeat(bound-framingBytes),
    }));
    assert.equal(decoded.byteLength,9_961_472);
    const wire=gzipSync(decoded);
    assert.ok(wire.byteLength<100*1024);
    const wireSha=createHash('sha256').update(wire).digest('hex');
    const decodedSha=createHash('sha256').update(decoded).digest('hex');
    const split=Math.floor(wire.length/2);
    assert.ok(split>0&&split<wire.length);
    // Keep all four parser slots reserved with incomplete gzip members,
    // then finish them without unbounded artificial delays.
    const db=new DatabaseSync(':memory:');
    db.exec(readFileSync(path.resolve('test/fixtures/s5-protected-share-local.sql'),'utf8'));
    const fair=new ProposedS5ProtectedTenantAdmission(db,{
      scope:'qa30-gzip-full-boundary-only',globalRollingMinuteLimit:60,
      tenants:[{tenantId:A,weight:1},{tenantId:B,weight:1}],
    });
    const app=createNexowireMcpExpressApp({host:HOST,allowedHosts:[HOST,'localhost']});
    let parsedLarge=0;
    app.post('/mcp',(req,res)=>{
      if(typeof req.body?.payload==='string'){
        parsedLarge++;
        res.json({kind:'gzip-decoded',bytes:Buffer.byteLength(
          JSON.stringify(req.body)),sha256:createHash('sha256')
          .update(JSON.stringify(req.body)).digest('hex')});
        return;
      }
      const tenant=req.headers['x-qa30-tenant'];
      if(tenant!==A&&tenant!==B){res.status(403).json({code:'TEST_SCOPE_ONLY'});return;}
      const id=typeof req.body?.id==='string'?req.body.id:'';
      const result=fair.observe(tenant,id,REQUEST_SHA,TIME);
      assert.equal(result.authorizesToolExecution,false);
      const accepted=result.status==='reserved';
      res.status(accepted?200:429).json({status:result.status,tenant});
    });
    const server=createServer(app);
    let arrivals=0;
    let resolveFour!:()=>void;
    const fourArrived=new Promise<void>(resolve=>{resolveFour=resolve;});
    server.on('request',req=>{
      if(req.headers['x-qa30-full-gzip']==='yes'){
        arrivals++;
        if(arrivals===4)resolveFour();
      }
    });
    const held:ClientRequest[]=[];
    const pending:Array<Promise<ResponseSummary>>=[];
    let rssPeak=process.memoryUsage().rss;
    const observe=()=>{rssPeak=Math.max(rssPeak,process.memoryUsage().rss);};
    const rssBaseline=process.memoryUsage().rss;
    let serving=false;
    try{
      await new Promise<void>((resolve,reject)=>{
        server.once('error',reject);
        server.listen(0,HOST,resolve);
      });
      serving=true;
      const addr=server.address();
      assert.ok(addr&&typeof addr!=='string');
      const url='http://'+HOST+':'+addr.port+'/mcp';
      for(let i=0;i<4;i++){
        const response=new Promise<ResponseSummary>((resolve,reject)=>{
          const client=request({host:HOST,port:addr.port,method:'POST',path:'/mcp',
            headers:{'content-type':'application/json','content-encoding':'gzip',
              'content-length':String(wire.byteLength),'x-qa30-full-gzip':'yes'}},res=>{
              const chunks:Buffer[]=[];
              res.on('data',c=>chunks.push(Buffer.from(c)));
              res.on('end',()=>{
                try{resolve({status:res.statusCode??0,
                  json:JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>});}
                catch(error){reject(error);}
              });
              res.on('error',reject);
            });
          client.on('error',reject);
          held.push(client);
          client.write(wire.subarray(0,split));
        });
        void response.catch(()=>{});
        pending.push(response);
      }
      await fourArrived;
      assert.equal(arrivals,4);
      assert.equal(parsedLarge,0);
      const fifth=await post(url,{'content-encoding':'gzip'},new Uint8Array(wire));
      assert.equal(fifth.status,503);
      assert.equal(fifth.json.code,'MCP_JSON_PARSER_BUSY');

      // A known seeded input order, eight bounded clients; timing itself
      // deliberately remains observational and OS-runner-dependent.
      const jobs=shuffle([
        ...Array.from({length:60},(_,i)=>({tenant:A,id:'qa30-noisy-'+String(i).padStart(3,'0')})),
        ...Array.from({length:30},(_,i)=>({tenant:B,id:'qa30-quiet-'+String(i).padStart(3,'0')})),
      ],SEED);
      const samples:Sample[]=[];
      let cursor=0;
      await Promise.all(Array.from({length:8},async()=>{
        while(cursor<jobs.length){
          const j=jobs[cursor++]!;
          const r=await post(url,{'x-qa30-tenant':j.tenant},JSON.stringify({id:j.id}));
          assert.equal(r.json.tenant,j.tenant);
          assert.ok(r.status===200||r.status===429);
          assert.equal(r.json.status,r.status===200?'reserved':'tenant-exhausted');
          samples.push({tenant:j.tenant,status:r.status,latencyMs:r.latencyMs});
        }
      }));
      observe();
      assert.equal(samples.length,90);
      assert.equal(samples.filter(s=>s.tenant===B&&s.status===200).length,30,
        'quiet tiny calls are not starved even with 4 large gzip parsers held');
      assert.equal(samples.filter(s=>s.tenant===A&&s.status===200).length,30);
      assert.equal(samples.filter(s=>s.status===429).length,30);
      assert.equal(parsedLarge,0,'large gzip bodies are still incomplete during tiny calls');

      for(const client of held)client.end(wire.subarray(split));
      const large=await Promise.all(pending);
      observe();
      assert.equal(parsedLarge,4);
      assert.equal(large.length,4);
      for(const r of large){
        assert.equal(r.status,200);
        assert.equal(r.json.kind,'gzip-decoded');
        assert.equal(r.json.bytes,bound);
        assert.equal(r.json.sha256,decodedSha);
      }
      const success=nearestRank(samples.filter(s=>s.status===200).map(s=>s.latencyMs));
      const denied=nearestRank(samples.filter(s=>s.status===429).map(s=>s.latencyMs));
      assert.ok(success.p99>=success.p95&&denied.p99>=denied.p95);
      const count=(db.prepare('SELECT COUNT(*) AS n FROM s5_fair_window').get() as {n:number}).n;
      assert.equal(count,60);
      process.stdout.write('QA30_GZIP95_FAIRNESS '+JSON.stringify({
        sourceBaseSha:PARSER_BASE_SHA,parentQaSha:PARENT_QA_SHA,
        workflowCheckoutSha:process.env.GITHUB_SHA??null,
        seed:SEED,classification:'FULL_4X9_5MIB_DECODED_LOCAL_GZIP_WITH_SYNTHETIC_TENANT_LEDGER',
        gzipRequests:4,decodedBodyBytesEach:bound,decodedBodyBytesTotal:4*bound,
        gzipWireBytesEach:wire.byteLength,gzipWireSha256:wireSha,
        decodedJsonSha256:decodedSha,largeHttp200:4,busyGzipHttp503:1,
        tinyAttempts:90,tinyAccepted:60,tinyRejected:30,
        tenantAccepted:{noisy:30,quiet:30},workers:8,
        successLatency:success,deniedLatency:denied,
        latencyClock:'performance.now request start to consumed response body',
        rssGrowthPeakObservedBytes:Math.max(0,rssPeak-rssBaseline),
        nativeToolCompletions:0,realAuthenticatedWss:0,paidCloudflareCost:null,
        acceptance:'SOURCE_ONLY_NO_GO',
      })+'\n');
    }finally{
      for(const client of held)client.destroy();
      if(serving){
        server.closeAllConnections();
        await new Promise<void>((resolve,reject)=>
          server.close(error=>error?reject(error):resolve()));
      }
      db.close();
    }
  });
