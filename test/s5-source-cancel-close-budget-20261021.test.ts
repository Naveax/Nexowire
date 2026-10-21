/**
 * S5 #15: isolated SOURCE-ONLY cancellation and fairness negative acceptance.
 * Test #598 Express parser over ephemeral 127.0.0.1 and staging-only SQLite.
 * A parser close event is NOT an authenticated Agent mutation receipt, and
 * releasing a parser slot is NOT proof that Node/V8 freed physical memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request,type ClientRequest,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {gzipSync} from 'node:zlib';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createNexowireMcpExpressApp} from '../src/mcp/http-app.js';
import {s5NearestRank,S5_SEED} from '../scripts/bench-s5-real-598-seeded.js';
import {StagingArtifactByteBudget,initArtifactBudgetFixture,ARTIFACT_CHUNK_BYTES}
  from '../src/ops/scale-v2-artifact-byte-budget-staging.js';
import {ProposedS5ProtectedTenantAdmission}
  from '../src/ops/scale-s5-protected-admission.js';

const HOST='127.0.0.1';
const SHA_A='a'.repeat(64),SHA_B='b'.repeat(64);
const A={ownerId:'s5-owner-noisy',deviceId:'s5-device-noisy',projectId:'s5-project-fixture'};
const B={ownerId:'s5-owner-quiet',deviceId:'s5-device-quiet',projectId:'s5-project-fixture'};
const NOW=new Date('2026-10-21T17:00:00.000Z');

test('S5 real #598: cancel intent does not release four parser slots before observed local close',
  {timeout:18000},async()=>{
    const app=createNexowireMcpExpressApp({host:HOST,allowedHosts:[HOST,'localhost']});
    app.post('/mcp',(_req,res)=>res.json({ok:true}));
    const server=createServer(app);
    let seen=0;
    let allArrived!:()=>void;
    const arrived=new Promise<void>(resolve=>{allArrived=resolve});
    const serverReplies:ServerResponse[]=[];
    server.on('request',(req,res)=>{
      if(req.headers['x-s5-hold']==='1'){
        serverReplies.push(res);
        if(++seen===4)allArrived();
      }
    });
    const held:ClientRequest[]=[];
    const smallMs:number[]=[];
    let sourceCloseAcks=0;
    try{
      server.listen(0,HOST);
      await once(server,'listening');
      const addr=server.address();
      assert.ok(addr&&typeof addr!=='string');
      const port=addr.port;
      const url='http://'+HOST+':'+port+'/mcp';
      async function post(body:string){
        const began=performance.now();
        const res=await fetch(url,{method:'POST',signal:AbortSignal.timeout(5000),
          headers:{'content-type':'application/json'},body});
        const data=await res.text();
        return {status:res.status,ms:performance.now()-began,data};
      }
      for(let i=0;i<4;i++){
        const client=request({host:HOST,port,path:'/mcp',method:'POST',
          headers:{'content-type':'application/json','transfer-encoding':'chunked',
            'x-s5-hold':'1'}});
        client.on('error',()=>{}); // deliberately incomplete fixture socket teardown
        held.push(client);
        client.write('{"payload":"unfinished');
      }
      await Promise.race([arrived,delay(4000).then(()=>{throw Error('S5_ARRIVAL_TIMEOUT')})]);
      assert.equal(serverReplies.length,4);
      for(let i=0;i<24;i++){
        const small=await post('{"ping":true}');
        assert.equal(small.status,200);
        smallMs.push(small.ms);
      }
      const largeJson=JSON.stringify({payload:'x'.repeat(128*1024)});
      const fifth=await post(largeJson);
      assert.equal(fifth.status,503);
      assert.match(fifth.data,/MCP_JSON_PARSER_BUSY/);
      const zip=gzipSync(Buffer.from(JSON.stringify({payload:'z'.repeat(512*1024)})));
      assert.ok(zip.byteLength<100*1024);
      const gz=await fetch(url,{method:'POST',signal:AbortSignal.timeout(5000),
        headers:{'content-type':'application/json','content-encoding':'gzip'},
        body:new Uint8Array(zip)});
      assert.equal(gz.status,503);
      await gz.arrayBuffer();

      // Local cancel intent must not be mistaken for an observed parser release.
      let cancellationRequested=true;
      assert.equal(sourceCloseAcks,0);
      const pending=await post(largeJson);
      assert.equal(pending.status,503);
      assert.equal(sourceCloseAcks,0);
      const localClose=new Promise<void>(resolve=>{
        serverReplies[0]!.once('close',()=>{sourceCloseAcks++;resolve()});
      });
      held[0]!.destroy();
      await Promise.race([localClose,
        delay(4000).then(()=>{throw Error('S5_LOCAL_CLOSE_ACK_TIMEOUT')})]);
      assert.equal(sourceCloseAcks,1);
      assert.ok(cancellationRequested);
      const afterAck=await post(largeJson);
      assert.equal(afterAck.status,200);
      assert.ok(s5NearestRank(smallMs,.99)>=s5NearestRank(smallMs,.95));
      process.stdout.write('S5_SOURCE_PARSER_CANCEL '+JSON.stringify({
        seed:S5_SEED,smallSuccesses:24,guardedLarge:4,
        smallP95Ms:s5NearestRank(smallMs,.95),
        smallP99Ms:s5NearestRank(smallMs,.99),
        preClose503:2,gzipBusy503:1,afterLocalClose200:1,
        authenticatedNativeCancelReceipt:false,physicalHeapFreed:false,
        publicWss:0,providerBill:null,
      })+'\n');
    }finally{
      for(const client of held)client.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  });

test('S5 staging ledger keeps pending byte reservations through unknown cancellation and bad receipts',()=>{
  const db=new DatabaseSync(':memory:');
  initArtifactBudgetFixture(db);
  const ledger=new StagingArtifactByteBudget(db);
  const size=ARTIFACT_CHUNK_BYTES;
  const openA={...A,sessionId:'s5-cancel-session-01',rootInvocationId:'s5-cancel-root-01',
    sizeBytes:size,sourceSha256:SHA_A,physicalFreeBytes:8*1024*1024*1024,now:NOW};
  const openB={...B,sessionId:'s5-quiet-session-01',rootInvocationId:'s5-quiet-root-01',
    sizeBytes:size,sourceSha256:SHA_A,physicalFreeBytes:8*1024*1024*1024,now:NOW};
  const pending={...A,sessionId:openA.sessionId,requestId:'s5-cancel-chunk-01',
    offsetBytes:0,byteCount:size,chunkSha256:SHA_B,now:NOW};
  const charged=()=>Number((db.prepare(
    "SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE state<>'RELEASED'"
  ).get() as {n:number}).n);
  try{
    assert.equal(ledger.begin(openA),'RESERVED');
    assert.equal(ledger.stageChunk(pending),'CHUNK_PENDING');
    assert.equal(charged(),size);
    // A simulated cancel intent has no authenticated physical cancel receipt.
    assert.equal(ledger.stageChunk({...pending,requestId:'s5-cancel-blind-retry'}),
      'DENIED_PENDING');
    assert.equal(ledger.acknowledgeDeletion({...A,sessionId:openA.sessionId,
      durableDeletionVerified:true}),'DENIED_STATE');
    assert.equal(ledger.commitChunk({...pending,storedSha256:SHA_A,
      durableStorageVerified:true}),'DENIED_REPLAY');
    assert.equal(charged(),size,'an unknown write cannot refund storage capacity');
    assert.equal(ledger.begin(openB),'RESERVED','quiet tenant can still reserve');
    assert.equal(charged(),2*size);
    assert.equal(ledger.stageChunk(pending),'CHUNK_PENDING');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM budget_artifact_chunks')
      .get() as {n:number}).n,1,'duplicate pending request does not charge again');
    assert.equal(ledger.commitChunk({...pending,storedSha256:SHA_B,
      durableStorageVerified:true}),'CHUNK_COMMITTED');
    assert.equal(ledger.finalize({...A,sessionId:openA.sessionId,
      storedSizeBytes:size,storedSha256:SHA_A,durableStorageVerified:true}),'COMPLETE');
    assert.equal(charged(),2*size,'even a completed stored file remains charged');
    assert.throws(()=>ledger.acknowledgeDeletion({...A,sessionId:openA.sessionId,
      durableDeletionVerified:false as unknown as true}),/DELETION_RECEIPT_REQUIRED/);
    assert.equal(charged(),2*size);
    assert.equal(ledger.acknowledgeDeletion({...A,sessionId:openA.sessionId,
      durableDeletionVerified:true}),'RELEASED');
    assert.equal(charged(),size);
    // The true marker is supplied by a synthetic trusted fixture, NOT a real
    // independently authenticated deletion or physical memory receipt.
  }finally{db.close();}
});

test('S5 fixed seed tenant budget transcript is reproducible without native grant or replay',()=>{
  const schedule=[...Array.from({length:55},(_,i)=>'noisy-'+i),
    ...Array.from({length:30},(_,i)=>'quiet-'+i)];
  let seed=S5_SEED;
  const next=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0};
  for(let i=schedule.length-1;i>0;i--){
    const j=next()%(i+1);
    [schedule[i],schedule[j]]=[schedule[j]!,schedule[i]!];
  }
  const run=()=>{
    const db=new DatabaseSync(':memory:');
    db.exec(readFileSync('test/fixtures/s5-protected-share-local.sql','utf8'));
    const meter=new ProposedS5ProtectedTenantAdmission(db,{
      scope:'s5-cancel-proof-tenant-20261021',globalRollingMinuteLimit:60,
      tenants:[{tenantId:'s5-owner-noisy',weight:1},{tenantId:'s5-owner-quiet',weight:1}],
    });
    let noisy=0,quiet=0,denied=0;
    const digest=createHash('sha256');
    try{
      for(const name of schedule){
        const tenant=name.startsWith('quiet')?'s5-owner-quiet':'s5-owner-noisy';
        const result=meter.observe(tenant,'s5-invoke-'+name,SHA_B,NOW);
        digest.update(name+':'+result.status+'\n');
        assert.equal(result.authorizesToolExecution,false);
        if(result.status==='reserved'){
          if(tenant==='s5-owner-quiet')quiet++;else noisy++;
        }else{
          assert.equal(result.status,'tenant-exhausted');
          denied++;
        }
      }
      const before=(db.prepare('SELECT COUNT(*) AS n FROM s5_fair_invocations')
        .get() as {n:number}).n;
      assert.equal(meter.observe('s5-owner-quiet','s5-invoke-quiet-0',SHA_B,NOW).status,
        'duplicate');
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM s5_fair_invocations')
        .get() as {n:number}).n,before);
      return {noisy,quiet,denied,transcriptSha256:digest.digest('hex')};
    }finally{db.close();}
  };
  const one=run(),two=run();
  assert.deepEqual(one,two,'fixed seed means deterministic admission decisions');
  assert.deepEqual({noisy:one.noisy,quiet:one.quiet,denied:one.denied},
    {noisy:30,quiet:30,denied:25});
  assert.match(one.transcriptSha256,/^[a-f0-9]{64}$/);
});


test('S5 synthetic 64KiB buffer lease retains referenced bytes until scoped witness receipt',()=>{
  // A specification fixture, NOT the deployed parser heap/GC or real Agent.
  const owner='s5-owner-noisy',job='s5-cancel-buffer-01',epoch=7;
  const key=Buffer.from('S5_TEST_ONLY_NOT_AN_EXTERNAL_ATTESTATION');
  let held:Buffer|null=Buffer.alloc(ARTIFACT_CHUNK_BYTES,0xa5);
  let pending=false;
  const bytesHeld=()=>held?.byteLength??0;
  const sign=(o:string,j:string,e:number)=>createHmac('sha256',key)
    .update(o+':'+j+':'+e+':writer-stopped').digest('hex');
  const ack=(r:{owner:string;job:string;epoch:number;writerStopped:boolean;mac:string})=>{
    if(!pending||!r.writerStopped||r.owner!==owner||r.job!==job||r.epoch!==epoch)
      return 'RETAINED';
    if(!/^[0-9a-f]{64}$/.test(r.mac))return 'RETAINED';
    if(!timingSafeEqual(Buffer.from(r.mac,'hex'),Buffer.from(sign(owner,job,epoch),'hex')))
      return 'RETAINED';
    held=null;
    return 'SOURCE_FIXTURE_RELEASED';
  };
  pending=true; // cancellation intent, not a verified native effect.
  assert.equal(bytesHeld(),ARTIFACT_CHUNK_BYTES);
  assert.equal(ack({owner,job,epoch,writerStopped:false,mac:sign(owner,job,epoch)}),
    'RETAINED');
  assert.equal(ack({owner:'s5-owner-quiet',job,epoch,writerStopped:true,
    mac:sign(owner,job,epoch)}),'RETAINED');
  assert.equal(ack({owner,job,epoch:epoch-1,writerStopped:true,
    mac:sign(owner,job,epoch-1)}),'RETAINED');
  assert.equal(ack({owner,job,epoch,writerStopped:true,
    mac:'a'.repeat(64)}),'RETAINED');
  assert.equal(bytesHeld(),ARTIFACT_CHUNK_BYTES,'source buffer remains strongly referenced');
  assert.equal(ack({owner,job,epoch,writerStopped:true,mac:sign(owner,job,epoch)}),
    'SOURCE_FIXTURE_RELEASED');
  assert.equal(bytesHeld(),0,'source reference released only after matched test witness');
  // Not proof of actual physical memory reclamation or off-host attestation.
});
