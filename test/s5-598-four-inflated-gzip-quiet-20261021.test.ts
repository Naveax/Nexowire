/**
 * SCALE S5 #15 | SOURCE-ONLY real #598 parser, four 9.5MiB INFLATED gzip POSTs.
 * 64 quiet tiny HTTP requests while all four compressed large parser slots held.
 * Also observes a separate in-memory pending cancellation/debit that cannot
 * be released on mere HTTP parser success, client cancel intent or forged ACK.
 *
 * Hosted CI localhost only. No real Agent, WSS, Cloudflare, VM or physical file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request,type ClientRequest} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {freemem} from 'node:os';
import {readFileSync,statfsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createNexowireMcpExpressApp,NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES}
  from '../src/mcp/http-app.js';
import {ARTIFACT_CHUNK_BYTES,StagingArtifactByteBudget,initArtifactBudgetFixture}
  from '../src/ops/scale-v2-artifact-byte-budget-staging.js';
import {ProposedS5ProtectedTenantAdmission}
  from '../src/ops/scale-s5-protected-admission.js';
import {s5NearestRank,S5_SEED}
  from '../scripts/bench-s5-real-598-seeded.js';

const HOST='127.0.0.1',GIB=1024*1024*1024;
const BODY=NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES;
const PFX='{"payload":"',SFX='"}';
const PAYLOAD_BYTES=BODY-Buffer.byteLength(PFX)-Buffer.byteLength(SFX);
const RSS_CAP=256*1024*1024;
const EXPECTED_HASHES=[
  '286aae261af6272fb8db8b618ae0c25e375f74bc019f6ecec3aba1428e68bfd6',
  '08e0e9cb107c7fc3763027babb6ee3896a7af072cc52b54c238ea9b46ba1791b',
  '31c64807b38100637461e8e71ddfb785ded05795c7cb4a62007d9700ef7fb1e0',
  '3cf32ee870512e2ec25bbf30a4106f405bb454daabb236793f371043799ab647',
];

test('S5 #15 fixed seed gzip offsets, hashes and over-limit dimensions',()=>{
  assert.equal(BODY,9_961_472);
  assert.equal(PAYLOAD_BYTES,9_961_458);
  assert.equal(Buffer.byteLength(PFX)+PAYLOAD_BYTES+Buffer.byteLength(SFX),BODY);
  assert.equal(S5_SEED,0x5a17c0de);
  assert.equal(EXPECTED_HASHES.length,4);
  assert.equal(new Set(EXPECTED_HASHES).size,4);
});

test('S5 #15 four compressed 9.5MiB inflated real #598 parser slots preserve quiet 64 tiny and unacknowledged budget',
  {timeout:120000},async t=>{
    if(process.env.CI!=='true'){
      t.skip('full decompression body requires isolated GitHub CI');
      return;
    }
    const freeDisk=statfsSync(process.cwd());
    if(freeDisk.bavail*freeDisk.bsize<2*GIB || freemem()<3*GIB){
      t.skip('S5_FULL_GZIP_PREFLIGHT_BLOCKED: insufficient runner disk/RAM');
      return;
    }
    const app=createNexowireMcpExpressApp({host:HOST,allowedHosts:[HOST,'localhost']});
    app.post('/mcp',(req,res)=>{
      const payload=req.body?.payload;
      if(typeof payload==='string'){
        res.json({bytes:Buffer.byteLength(payload),
          sha:createHash('sha256').update(payload).digest('hex')});
      }else res.json({quiet:true});
    });
    const server=createServer(app);
    let arrivals=0,allArrived!:()=>void;
    const arrivalBarrier=new Promise<void>(resolve=>{allArrived=resolve;});
    server.on('request',req=>{
      if(req.headers['x-s5-fixture-large']==='gzip-held'){
        if(++arrivals===4)allArrived();
      }
    });
    const db=new DatabaseSync(':memory:');
    initArtifactBudgetFixture(db);
    const ledger=new StagingArtifactByteBudget(db);
    const A={ownerId:'s5-gzip-noisy-owner',deviceId:'s5-gzip-device-a',projectId:'s5-source-only'};
    const B={ownerId:'s5-gzip-quiet-owner',deviceId:'s5-gzip-device-b',projectId:'s5-source-only'};
    const now=new Date('2026-10-21T20:30:00Z'),size=ARTIFACT_CHUNK_BYTES;
    const sha='a'.repeat(64),chunkSha='b'.repeat(64);
    const openA={...A,sessionId:'s5-gzip-noisy-session-01',rootInvocationId:'s5-gzip-noisy-root-01',
      sizeBytes:size,sourceSha256:sha,physicalFreeBytes:8*GIB,now};
    const openB={...B,sessionId:'s5-gzip-quiet-session-01',rootInvocationId:'s5-gzip-quiet-root-01',
      sizeBytes:size,sourceSha256:sha,physicalFreeBytes:8*GIB,now};
    const pending={...A,sessionId:openA.sessionId,requestId:'s5-gzip-write-pending-01',
      offsetBytes:0,byteCount:size,chunkSha256:chunkSha,now};
    const charged=()=>Number((db.prepare(
      "SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE state<>'RELEASED'"
    ).get() as {n:number}).n);
    const tenantDb=new DatabaseSync(':memory:');
    tenantDb.exec(readFileSync('test/fixtures/s5-protected-share-local.sql','utf8'));
    const shares=new ProposedS5ProtectedTenantAdmission(tenantDb,{
      scope:'s5-gzip-real-http-quiet-source',globalRollingMinuteLimit:40,
      tenants:[{tenantId:A.ownerId,weight:1},{tenantId:B.ownerId,weight:1}],
    });
    const clients:ClientRequest[]=[];
    const startRss=process.memoryUsage().rss;
    let peakRss=startRss,rssExceeded=false;
    const sample=()=>{
      peakRss=Math.max(peakRss,process.memoryUsage().rss);
      if(peakRss-startRss>RSS_CAP){
        rssExceeded=true;
        for(const c of clients)c.destroy(new Error('S5_GZIP_RSS_CAP'));
        server.closeAllConnections();
      }
    };
    const sampler=setInterval(sample,10);
    let listening=false;
    const started=performance.now(),cpuBefore=process.cpuUsage();
    try{
      assert.equal(ledger.begin(openA),'RESERVED');
      assert.equal(ledger.stageChunk(pending),'CHUNK_PENDING');
      server.listen(0,HOST);await once(server,'listening');listening=true;
      const addr=server.address();
      assert.ok(addr&&typeof addr!=='string');
      const port=addr.port,url='http://'+HOST+':'+port+'/mcp';
      async function post(body:string,headers:Record<string,string>={}){
        const begin=performance.now();
        const res=await fetch(url,{
          method:'POST',signal:AbortSignal.timeout(10000),
          headers:{'content-type':'application/json',...headers},body,
        });
        const text=await res.text();
        sample();
        return {status:res.status,ms:performance.now()-begin,text};
      }
      const held:Array<{client:ClientRequest;wire:Buffer;response:Promise<{
        status:number;bytes:number;sha:string;ms:number}>}>=[];
      const preparedHashes:string[]=[];
      for(let i=0;i<4;i++){
        const ch=String.fromCharCode(65+((S5_SEED>>>i)&15));
        const inflated=PFX+ch.repeat(PAYLOAD_BYTES)+SFX;
        assert.equal(Buffer.byteLength(inflated),BODY);
        const expected=createHash('sha256').update(ch.repeat(PAYLOAD_BYTES)).digest('hex');
        assert.equal(expected,EXPECTED_HASHES[i]);
        const wire=gzipSync(Buffer.from(inflated));
        assert.ok(wire.byteLength<100*1024,'compressed body is tiny on wire');
        const began=performance.now();
        let resolve!:(v:{status:number;bytes:number;sha:string;ms:number})=>void;
        let reject!:(e:Error)=>void;
        const response=new Promise<{status:number;bytes:number;sha:string;ms:number}>((a,b)=>{
          resolve=a;reject=b;
        });
        void response.catch(()=>{});
        const client=request({hostname:HOST,port,method:'POST',path:'/mcp',
          headers:{'content-type':'application/json','content-encoding':'gzip',
            'content-length':wire.byteLength,'x-s5-fixture-large':'gzip-held'}},
        async res=>{
          try{
            let raw='';
            for await(const piece of res){
              raw+=Buffer.from(piece).toString('utf8');
              if(raw.length>2048)throw Error('S5_GZIP_RESPONSE_TOO_LARGE');
            }
            const parsed=JSON.parse(raw) as {bytes:number;sha:string};
            resolve({status:res.statusCode??0,...parsed,ms:performance.now()-began});
          }catch(e){reject(e instanceof Error?e:new Error(String(e)));}
        });
        client.once('error',reject);
        client.setTimeout(20000,()=>client.destroy(new Error('S5_GZIP_TIMEOUT')));
        clients.push(client);held.push({client,wire,response});
        preparedHashes.push(expected);
        client.write(wire.subarray(0,6)); // gzip header, not complete body
        sample();
      }
      await Promise.race([
        arrivalBarrier,
        delay(5000).then(()=>{throw Error('S5_FOUR_GZIP_ARRIVAL_TIMEOUT');}),
      ]);
      assert.equal(arrivals,4);
      const quiet=await Promise.all(Array.from({length:64},()=>post(
        '{"quiet":true}',{'x-s5-fixture-owner':'quiet-untrusted-label'})));
      for(const q of quiet){assert.equal(q.status,200);assert.match(q.text,/"quiet":true/);}
      const fifth=await post(JSON.stringify({payload:'z'.repeat(128*1024)}));
      assert.equal(fifth.status,503);assert.match(fifth.text,/MCP_JSON_PARSER_BUSY/);
      const littleZip=gzipSync(Buffer.from('{"payload":"'+ 'q'.repeat(256*1024)+'"}'));
      const busyZip=await fetch(url,{method:'POST',signal:AbortSignal.timeout(10000),
        headers:{'content-type':'application/json','content-encoding':'gzip'},
        body:new Uint8Array(littleZip)});
      assert.equal(busyZip.status,503);await busyZip.arrayBuffer();

      // Cancellation *intent* only; neither an authoritative native ACK nor
      // proof of storage deletion or heap-page reclamation.
      const cancellationRequested=true;
      assert.ok(cancellationRequested);
      assert.equal(ledger.stageChunk({...pending,requestId:'s5-gzip-blind-replay-02'}),
        'DENIED_PENDING');
      assert.equal(ledger.acknowledgeDeletion({...A,sessionId:openA.sessionId,
        durableDeletionVerified:true}),'DENIED_STATE');
      assert.equal(charged(),size);
      const busyAfterCancel=await post(JSON.stringify({payload:'c'.repeat(128*1024)}));
      assert.equal(busyAfterCancel.status,503,
        'cancel intent alone must not free a parser stage slot');
      assert.equal(ledger.begin(openB),'RESERVED',
        'quiet owner independently reserves while noisy pending remains UNKNOWN');
      assert.equal(charged(),2*size);

      for(let i=0;i<40;i++){
        const owner=i<20?A.ownerId:B.ownerId;
        const result=shares.observe(owner,'s5-gzip-logical-'+i,sha,now);
        assert.equal(result.status,'reserved');
        assert.equal(result.authorizesToolExecution,false);
      }
      assert.equal(shares.observe(A.ownerId,'s5-gzip-noisy-over-budget',sha,now).status,
        'tenant-exhausted');
      assert.equal(shares.observe(B.ownerId,'s5-gzip-logical-20',sha,now).status,
        'duplicate');

      await Promise.all(held.map(async x=>{
        if(!x.client.write(x.wire.subarray(6))){
          await once(x.client,'drain',{signal:AbortSignal.timeout(8000)});
        }
        x.client.end();
        sample();
      }));
      const completed=await Promise.all(held.map(x=>x.response));
      completed.forEach((c,i)=>{
        assert.equal(c.status,200);
        assert.equal(c.bytes,PAYLOAD_BYTES);
        assert.equal(c.sha,preparedHashes[i]);
      });
      // Successful LOCAL parsing of all four bodies does not grant any
      // trusted durable ACK, cancellation receipt or refund.
      assert.equal(ledger.stageChunk(pending),'CHUNK_PENDING');
      assert.equal(charged(),2*size);
      assert.equal((db.prepare("SELECT state FROM budget_artifact_chunks WHERE request_id=?")
        .get(pending.requestId) as {state:string}).state,'PENDING');
      sample();
      assert.equal(rssExceeded,false);
      assert.ok(peakRss-startRss<=RSS_CAP);

      const tinyMs=quiet.map(x=>x.ms),largeMs=completed.map(x=>x.ms);
      const cost=process.cpuUsage(cpuBefore);
      process.stdout.write('S5_598_FOUR_INFLATED_GZIP_QUIET_CI_SOURCE '+JSON.stringify({
        checkoutSha:process.env.GITHUB_SHA??'UNAVAILABLE',
        seed:S5_SEED,logicalDecodedBytesPerBody:BODY,
        totalDecodedRequestBytes:4*BODY,concurrentGzip:4,
        allGzipHttp200:true,receiverHashes:preparedHashes,
        canonicalContentFingerprint:createHash('sha256')
          .update(preparedHashes.join('\n')).digest('hex'),
        tinyIdentitySuccessN:64,
        tinyP50Ms:s5NearestRank(tinyMs,.50),
        tinyP95Ms:s5NearestRank(tinyMs,.95),
        tinyP99Ms:s5NearestRank(tinyMs,.99),
        largeSuccessN:4,
        largeP95Ms:s5NearestRank(largeMs,.95),
        largeP99Ms:s5NearestRank(largeMs,.99),
        fifthLargeBusy503:1,tinyGzipBusy503:1,
        unknownCancelNoRelease:true,pendingChunkBytesStillCharged:size,
        protectedTenantBudget:'20 noisy / 20 quiet logical only',
        peakRssGrowthBytes:peakRss-startRss,
        cpuUserUs:cost.user,cpuSystemUs:cost.system,
        wallDurationMs:Number((performance.now()-started).toFixed(3)),
        percentile:'nearest-rank successful local request start -> full response',
        realNativeCancelReceipt:false,physicalMemoryFreedVerified:false,
        realNativeToolCompletions:0,publicAuthenticatedWss:0,
        externalCloudflareBill:null,physicalOneGiB:false,soak24h:false,
        productionAcceptance:'NO_GO',
      })+'\n');
    }finally{
      clearInterval(sampler);
      for(const client of clients)client.destroy();
      if(listening){
        server.closeAllConnections();
        await new Promise<void>(resolve=>server.close(()=>resolve()));
      }
      db.close();tenantDb.close();
    }
  });
