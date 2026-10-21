/**
 * Worker #30: real #598 Express parser, isolated localhost transport.
 * Source-only: no Hub/Agent, WSS, auth tokens, Cloudflare, billing or privileged calls.
 * No sleep-based racing: wait for the server's request event for all held uploads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {
  createNexowireMcpExpressApp,
  NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES,
} from '../src/mcp/http-app.js';

const HOST='127.0.0.1';
const boundFetch=(url:string,body:string|Uint8Array,encoding?:string)=>fetch(url,{
  method:'POST',redirect:'manual',signal:AbortSignal.timeout(6000),
  headers:{'content-type':'application/json',...(encoding?{'content-encoding':encoding}:{})},
  body:typeof body==='string'?body:new Uint8Array(body),
});
type Sample=Readonly<{label:'success'|'rejected'|'cancelled';ms:number}>;
function nearestRankSuccessful(samples:readonly Sample[]){
  const xs=samples.filter(x=>x.label==='success').map(x=>x.ms);
  if(xs.length===0||xs.some(x=>!Number.isFinite(x)||x<0))
    throw Error('NO_VALID_SUCCESS_LATENCY');
  xs.sort((a,b)=>a-b);
  const rank=(p:number)=>xs[Math.ceil(p*xs.length)-1]!;
  return {unit:'ms' as const,clock:'performance.now' as const,
    boundary:'before request -> response body consumed' as const,
    method:'nearest-rank' as const,successN:xs.length,attemptedN:samples.length,
    p50:rank(0.50),p95:rank(0.95),p99:rank(0.99)};
}

test('worker30 p95/p99 provenance excludes 503/cancel and never invents provider SLO',()=>{
  const samples:Sample[]=[
    ...Array.from({length:19},()=>({label:'success' as const,ms:2})),
    {label:'success',ms:100},
    {label:'rejected',ms:1},
    {label:'cancelled',ms:0},
  ];
  const r=nearestRankSuccessful(samples);
  assert.deepEqual({n:r.successN,attempts:r.attemptedN,p95:r.p95,p99:r.p99},
    {n:20,attempts:22,p95:2,p99:100});
  assert.equal(nearestRankSuccessful([
    {label:'success',ms:1},{label:'success',ms:2},
    {label:'success',ms:3},{label:'success',ms:4},
  ]).p95,4,'N=4 p95 and p99 both select the slowest sample');
  assert.throws(()=>nearestRankSuccessful([{label:'rejected',ms:5}]),
    /NO_VALID_SUCCESS_LATENCY/);
  assert.throws(()=>nearestRankSuccessful([{label:'success',ms:Infinity}]),
    /NO_VALID_SUCCESS_LATENCY/);
});

test('worker30 actual gzip inflation is bounded by #598 JSON limit, not wire size',
  {timeout:20000},async()=>{
    const app=createNexowireMcpExpressApp({host:HOST,allowedHosts:[HOST,'localhost']});
    app.post('/mcp',(req,res)=>res.json({
      parsedLength:typeof req.body?.payload==='string'?req.body.payload.length:0,
    }));
    const server=createServer(app);
    await new Promise<void>((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,HOST,resolve);
    });
    try{
      const address=server.address();
      assert.ok(address&&typeof address!=='string');
      const url='http://'+HOST+':'+address.port+'/mcp';
      const smallJson=JSON.stringify({payload:'z'.repeat(1024*1024)});
      const compressed=gzipSync(Buffer.from(smallJson));
      assert.ok(compressed.byteLength<100*1024);
      const ok=await boundFetch(url,new Uint8Array(compressed),'gzip');
      assert.equal(ok.status,200);
      assert.equal((await ok.json() as {parsedLength:number}).parsedLength,1024*1024);

      // Only ~10 MiB in memory, never a huge physical fixture.
      const explosiveJson=JSON.stringify({
        payload:'z'.repeat(NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES),
      });
      const wire=gzipSync(Buffer.from(explosiveJson));
      assert.ok(wire.byteLength<100*1024);
      const denied=await boundFetch(url,new Uint8Array(wire),'gzip');
      assert.equal(denied.status,413,
        'decompressed size, not tiny gzip Content-Length, must hit the limit');
      const recovery=await boundFetch(url,'{}');
      assert.equal(recovery.status,200,'rejection releases parser resources');
    }finally{
      server.closeAllConnections();
      await new Promise<void>((resolve,reject)=>
        server.close(error=>error?reject(error):resolve()));
    }
  });

test('worker30 four deterministic incomplete large uploads preserve small path; fifth/gzip fail closed',
  {timeout:20000},async()=>{
    const app=createNexowireMcpExpressApp({host:HOST,allowedHosts:[HOST,'localhost']});
    app.post('/mcp',(_req,res)=>res.json({ok:true}));
    const server=createServer(app);
    let seen=0;
    let releaseArrival:()=>void=()=>{};
    const fourArrived=new Promise<void>(resolve=>{releaseArrival=resolve;});
    const heldServerReplies:Array<{once:(name:string,callback:()=>void)=>unknown}>=[];
    server.on('request',(req,res)=>{
      if(req.headers['x-worker30-hold']==='1'){
        heldServerReplies.push(res);
        if(++seen===4)releaseArrival();
      }
    });
    await new Promise<void>((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,HOST,resolve);
    });
    const heldClients:ReturnType<typeof request>[]=[];
    try{
      const address=server.address();
      assert.ok(address&&typeof address!=='string');
      const url='http://'+HOST+':'+address.port+'/mcp';
      for(let n=0;n<4;n++){
        const client=request({
          host:HOST,port:address.port,method:'POST',path:'/mcp',
          headers:{'content-type':'application/json',
            'transfer-encoding':'chunked','x-worker30-hold':'1'},
        });
        client.on('error',()=>{}); // expected only from this fixture's teardown
        heldClients.push(client);
        client.write('{"payload":"unfinished');
      }
      await fourArrived; // real server-side request barrier, no arbitrary delay
      assert.equal(heldServerReplies.length,4);
      const smallLatency:Sample[]=[];
      for(let n=0;n<8;n++){
        const t0=performance.now();
        const response=await boundFetch(url,'{"small":true}');
        const payload=await response.json() as {ok:boolean};
        smallLatency.push({label:response.status===200?'success':'rejected',
          ms:performance.now()-t0});
        assert.equal(response.status,200);
        assert.equal(payload.ok,true);
      }
      const tooMany=await boundFetch(url,JSON.stringify({
        payload:'p'.repeat(221*1024),
      }));
      assert.equal(tooMany.status,503);
      assert.equal((await tooMany.json() as {code:string}).code,'MCP_JSON_PARSER_BUSY');
      const bomb=gzipSync(Buffer.from(JSON.stringify({
        payload:'x'.repeat(1024*1024),
      })));
      assert.ok(bomb.byteLength<100*1024);
      const compressed=await boundFetch(url,new Uint8Array(bomb),'gzip');
      assert.equal(compressed.status,503,'tiny compressed wire must consume large slot');
      assert.equal((await compressed.json() as {code:string}).code,
        'MCP_JSON_PARSER_BUSY');
      const p=nearestRankSuccessful(smallLatency);
      assert.equal(p.successN,8);
      assert.ok(p.p99>=p.p95&&p.p95>=p.p50);
      // Values are local observed timings only, never an SLO / true WSS claim.
      const closes=heldServerReplies.map(res=>new Promise<void>(resolve=>
        res.once('close',resolve)));
      for(const c of heldClients)c.destroy();
      await Promise.all(closes);
      const recovered=await boundFetch(url,JSON.stringify({
        payload:'p'.repeat(221*1024),
      }));
      assert.equal(recovered.status,200);
    }finally{
      for(const c of heldClients)c.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve,reject)=>
        server.close(error=>error?reject(error):resolve()));
    }
  });
