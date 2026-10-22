/**
 * Worker30 independent test: after a *witnessed* close of one held parser
 * request, exactly that vacant parser slot may be occupied. A cancellation
 * intent alone cannot release a slot. Real proposed #598 Express, localhost.
 * Synthetic tenant headers are NOT authenticated tenant reservations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request, type ClientRequest, type ServerResponse} from 'node:http';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createNexowireMcpExpressApp} from '../src/mcp/http-app.js';

const HOST='127.0.0.1';
const SEED=0x30ca5e21;
const PARENT_QA_HEAD='f730943fb2392cbc9b55c11e41750c43802c3482';
const SOURCE_SHA='cf58e6882e44968698f3f548b353287ba1698747';
type Slot={id:string;arrived:Promise<void>;closed:Promise<void>;
  signalArrival:()=>void;signalClosed:()=>void;
  response:ServerResponse|null;client:ClientRequest|null};
function slot(id:string):Slot{
  let signalArrival!:()=>void,signalClosed!:()=>void;
  const arrived=new Promise<void>(r=>{signalArrival=r;});
  const closed=new Promise<void>(r=>{signalClosed=r;});
  return {id,arrived,closed,signalArrival,signalClosed,response:null,client:null};
}
function quantileMs(values:number[],p:number):number {
  assert.ok(values.length>0&&values.every(v=>Number.isFinite(v)&&v>=0));
  const ordered=[...values].sort((a,b)=>a-b);
  return Number(ordered[Math.ceil(values.length*p)-1]!.toFixed(3));
}
test('QA30 only a witnessed parser close opens a single quiet-gzip admission slot',
  {timeout:30000},async()=>{
    const app=createNexowireMcpExpressApp({host:HOST,allowedHosts:[HOST,'localhost']});
    let acceptedCompressed=0,acceptedFramed=0;
    app.post('/mcp',(req,res)=>{
      if(typeof req.body?.data==='string'){
        acceptedCompressed++;
        res.json({parsedBytes:req.body.data.length,sha256:createHash('sha256')
          .update(JSON.stringify(req.body)).digest('hex')});
      }else{
        acceptedFramed++;
        res.json({ok:true,tenant:req.headers['x-qa30-tenant']});
      }
    });
    const server=createServer(app);
    const slots=new Map<string,Slot>();
    server.on('request',(req,res)=>{
      const id=req.headers['x-qa30-held'];
      if(typeof id!=='string')return;
      const current=slots.get(id);
      assert.ok(current,'only explicitly fixture-created holds are expected');
      current.response=res;
      res.once('close',current.signalClosed);
      current.signalArrival();
    });
    const decoded=Buffer.from(JSON.stringify({data:'z'.repeat(1024*1024)}));
    const compressed=gzipSync(decoded);
    const digest=createHash('sha256').update(decoded).digest('hex');
    assert.ok(compressed.length<100*1024);
    let listening=false;
    try{
      await new Promise<void>((resolve,reject)=>{
        server.once('error',reject);
        server.listen(0,HOST,resolve);
      });
      listening=true;
      const addr=server.address();
      assert.ok(addr&&typeof addr!=='string');
      const port=addr.port; // narrow AddressInfo before capture by hold()
      const url='http://'+HOST+':'+port+'/mcp';
      function hold(id:string,tenant:string):Slot{
        const s=slot(id);slots.set(id,s);
        const client=request({host:HOST,port,method:'POST',path:'/mcp',
          headers:{'content-type':'application/json','content-encoding':'gzip',
            'content-length':String(compressed.byteLength),
            'x-qa30-held':id,'x-qa30-tenant':tenant}},
        ()=>{throw Error('PARTIAL_GZIP_UNEXPECTED_RESPONSE')});
        client.on('error',()=>{}); // intentional fixture client teardown
        s.client=client;
        client.write(compressed.subarray(0,Math.floor(compressed.length/2)));
        return s;
      }
      async function gzipPost(tenant:string){
        const res=await fetch(url,{method:'POST',signal:AbortSignal.timeout(5000),
          headers:{'content-type':'application/json','content-encoding':'gzip',
            'x-qa30-tenant':tenant},body:new Uint8Array(compressed)});
        return {status:res.status,body:await res.json() as Record<string,unknown>};
      }
      const noisy=Array.from({length:4},(_,i)=>hold('noisy-'+i,'noisy'));
      await Promise.all(noisy.map(s=>s.arrived));
      assert.equal(acceptedCompressed,0);
      const firstQuiet=await gzipPost('quiet');
      assert.equal(firstQuiet.status,503);
      assert.equal(firstQuiet.body.code,'MCP_JSON_PARSER_BUSY');
      // "Cancel requested" is only a test variable, NOT proof the response
      // closed, bytes were reclaimed, or native effects stopped.
      const cancellationIntent=true;
      assert.equal(cancellationIntent,true);
      const stillBusy=await gzipPost('quiet');
      assert.equal(stillBusy.status,503);
      assert.equal(acceptedCompressed,0);

      noisy[0]!.client!.destroy();
      await noisy[0]!.closed; // real server-side socket close, not a timer
      const quietHeld=hold('quiet-replacement','quiet');
      await quietHeld.arrived;
      // 3 noisy + 1 quiet incomplete gzip occupy all parser slots.
      const anotherQuiet=await gzipPost('quiet');
      assert.equal(anotherQuiet.status,503);
      assert.equal(anotherQuiet.body.code,'MCP_JSON_PARSER_BUSY');
      assert.equal(acceptedCompressed,0);

      const latencies:number[]=[];
      for(let i=0;i<16;i++){
        const begin=performance.now();
        const res=await fetch(url,{method:'POST',
          signal:AbortSignal.timeout(5000),
          headers:{'content-type':'application/json','x-qa30-tenant':'quiet'},
          body:JSON.stringify({requestId:'qa30-framed-quiet-'+i})});
        const body=await res.json() as {ok:boolean;tenant:string};
        latencies.push(performance.now()-begin);
        assert.equal(res.status,200);
        assert.deepEqual(body,{ok:true,tenant:'quiet'});
      }
      assert.equal(acceptedFramed,16);
      assert.equal(acceptedCompressed,0);
      quietHeld.client!.destroy();
      await quietHeld.closed; // close of a *different* holder
      // Only three noisy parser requests remain held.
      const afterVerifiedClose=await gzipPost('quiet');
      assert.equal(afterVerifiedClose.status,200);
      assert.equal(afterVerifiedClose.body.parsedBytes,1024*1024);
      assert.equal(afterVerifiedClose.body.sha256,digest);
      assert.equal(acceptedCompressed,1);
      const summary={p50:quantileMs(latencies,.5),
        p95:quantileMs(latencies,.95),p99:quantileMs(latencies,.99)};
      assert.ok(summary.p99>=summary.p95&&summary.p95>=summary.p50);
      process.stdout.write('QA30_SINGLE_SLOT_CLOSE '+JSON.stringify({
        parentQaHead:PARENT_QA_HEAD,parserSourceSha:SOURCE_SHA,
        workflowCheckoutSha:process.env.GITHUB_SHA??null,seed:SEED,
        classification:'LOCAL_REAL_EXPRESS_PARSER_CLOSE_BARRIER_ONLY',
        initialNoisyGzipHolds:4,quietGzipBeforeCloseHttp503:2,
        quietGzipDuringFourHoldsHttp503:1,
        quietFramedIdentitySuccessN:16,quietFramedIdentityLatencyMs:{
          n:16,method:'nearest-rank',clock:'performance.now request to consumed reply',...summary,
        },
        quietGzipAfterWitnessedSingleCloseHttp200:1,
        parsedGzipSha256:digest,remainingNoisyHeld:3,
        tenantAuthorizationVerified:false,independentNativeWriterStopped:false,
        nativeWss:0,physicalOneGiBFiles:0,actualCloudflareCost:null,
        productionAcceptance:'NO_GO',
      })+'\n');
    }finally{
      for(const s of slots.values())s.client?.destroy();
      if(listening){
        server.closeAllConnections();
        await new Promise<void>((resolve,reject)=>
          server.close(e=>e?reject(e):resolve()));
      }
    }
  });
