/**
 * S5 ONLY. Real bytes through bounded 127.0.0.1 HTTP test fixture.
 * NOT a call to Nexowire Hub / MCP handler / #598 parser / Cloudflare.
 * Never attach to a customer/production hostname; no external URL option.
 */
import {createServer,request,type Server,type IncomingMessage,type ServerResponse} from 'node:http';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';

export const S5_HTTP_MAX_BYTES=9.5*1024*1024;
export const S5_HTTP_CHUNK_BYTES=64*1024;
export interface S5HttpIsolationOptions {
  largeRequests?:number;
  largeRequestBytes?:number;
  smallRequests?:number;
  perChunkPauseMs?:number;
  runLimitMs?:number;
  rssGrowthBudgetBytes?:number;
  probeFifthRequest?:boolean;
  probeOverLimit?:boolean;
}
export interface S5HttpIsolationResult {
  classification:'REAL_LOCAL_HTTP_BYTES_SYNTHETIC_MCP_FIXTURE';
  configuredHttpBodyMaxBytes:number;
  configuredLargeInFlightCap:4;
  largeSuccessful:number;
  largePeakActive:number;
  smallSuccessful:number;
  smallArrivedDuringLarge:number;
  smallLatencyMs:{p50:number;p95:number;p99:number};
  largeLatencyMs:{p50:number;p95:number;p99:number};
  http413Count:number;
  http429Count:number;
  backpressureWrites:number;
  bytesReceived:number;
  receivedHashes:string[];
  rssGrowthPeakBytes:number;
  memoryBudgetBytes:number;
  externalWssAuthenticated:0;
  actualNativeToolCompletions:0;
  cloudflareMeterReadings:null;
}
const check=(v:number,min:number,max:number,label:string)=>{
  if(!Number.isSafeInteger(v)||v<min||v>max)throw new Error('S5 bounded input invalid: '+label);
};
const pctl=(a:number[],p:number)=>{
  if(!a.length)return 0;
  const sorted=[...a].sort((x,y)=>x-y);
  return Number((sorted[Math.ceil(sorted.length*p)-1]??0).toFixed(3));
};
const error=(v:unknown)=>v instanceof Error?v:new Error(String(v));
export async function runS5LocalHttpIsolation(options:S5HttpIsolationOptions={}):Promise<S5HttpIsolationResult>{
  const count=options.largeRequests??4,size=options.largeRequestBytes??128*1024;
  const smallCount=options.smallRequests??12,pause=options.perChunkPauseMs??1;
  const limit=options.runLimitMs??20000,budget=options.rssGrowthBudgetBytes??128*1024*1024;
  check(count,1,4,'large requests');
  check(size,1,S5_HTTP_MAX_BYTES,'large request bytes');
  check(smallCount,1,32,'small requests');
  check(pause,0,3,'server chunk processing pause');
  check(limit,1000,60000,'deadline');
  check(budget,32*1024*1024,256*1024*1024,'memory budget');
  const started=performance.now(),rssStart=process.memoryUsage().rss;
  let rssPeak=rssStart,largeActive=0,largePeak=0,smallArrived=0,smallOk=0;
  let largeOk=0,rejected413=0,rejected429=0,networkBytes=0,backpressureWrites=0;
  let allStarted!:()=>void;
  const barrier=new Promise<void>(resolve=>{allStarted=resolve});
  const receiverHashes:string[]=[],smallLatency:number[]=[],largeLatency:number[]=[];
  const assertResources=()=>{
    rssPeak=Math.max(rssPeak,process.memoryUsage().rss);
    if(rssPeak-rssStart>budget)throw new Error('S5 fixture memory stop condition');
    if(performance.now()-started>limit)throw new Error('S5 fixture deadline');
  };
  const server:Server=createServer((req:IncomingMessage,res:ServerResponse)=>{
    if(req.url==='/mcp/small'&&req.method==='GET'){
      if(largeActive>0)smallArrived++;
      smallOk++;
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({jsonrpc:'2.0',result:{status:'synthetic-fixture'},id:'s5-small'}));
      return;
    }
    if(req.url!=='/mcp/large'||req.method!=='POST'){
      res.writeHead(404).end();return;
    }
    if(largeActive>=4){rejected429++;res.writeHead(429).end('synthetic concurrency cap');req.resume();return}
    if(Number(req.headers['content-length']??0)>S5_HTTP_MAX_BYTES){
      rejected413++;res.writeHead(413).end('synthetic body cap');req.resume();return;
    }
    largeActive++;largePeak=Math.max(largePeak,largeActive);
    if(largeActive===count)allStarted();
    void(async()=>{
      const digest=createHash('sha256');
      let length=0,valid=true;
      try{
        await barrier;
        for await(const part of req){
          const payload=Buffer.isBuffer(part)?part:Buffer.from(part);
          length+=payload.byteLength;
          if(length>S5_HTTP_MAX_BYTES){
            valid=false;rejected413++;res.writeHead(413).end('synthetic streaming body cap');
            break;
          }
          digest.update(payload);networkBytes+=payload.byteLength;
          if(pause)await sleep(pause);
          assertResources();
        }
        if(valid){
          largeOk++;
          const sha=digest.digest('hex');receiverHashes.push(sha);
          res.setHeader('Content-Type','application/json');
          res.end(JSON.stringify({status:'accepted-fixture',sha256:sha,receivedBytes:length}));
        }
      }catch{
        if(!res.headersSent)res.writeHead(503).end('fixture safe-stop');
      }finally{largeActive--;}
    })();
  });
  const active=new Set<ReturnType<typeof request>>();
  const localRequest=(route:string,bodyLength:number,overlimitHeader=false):Promise<{status:number;latency:number;sha:string|null}>=>{
    return new Promise((resolve,reject)=>{
      const began=performance.now(),digest=createHash('sha256');
      const req=request({
        host:'127.0.0.1',port:(server.address() as {port:number}).port,path:route,
        method:route==='/mcp/small'?'GET':'POST',
        agent:false,
        headers:route==='/mcp/large'?{'Content-Length':overlimitHeader?S5_HTTP_MAX_BYTES+1:bodyLength}: {},
      },async res=>{
        try{
          let response='';
          for await(const b of res){
            response+=b.toString();
            if(response.length>2048)throw new Error('Oversize fixture response');
          }
          const latency=performance.now()-began;
          let sha:string|null=null;
          if(res.statusCode===200&&route==='/mcp/large'){
            const parsed=JSON.parse(response) as {receivedBytes:number;sha256:string};
            if(parsed.receivedBytes!==bodyLength||parsed.sha256!==digest.digest('hex')){
              throw new Error('Fixture HTTP end-to-end bytes/hash mismatch');
            }
            sha=parsed.sha256;
          }
          resolve({status:res.statusCode??0,latency,sha});
        }catch(e){reject(error(e))}
        finally{active.delete(req)}
      });
      active.add(req);
      req.on('error',e=>{active.delete(req);reject(e)});
      req.setTimeout(Math.min(limit,15000),()=>req.destroy(new Error('HTTP fixture deadline')));
      if(route==='/mcp/small'||overlimitHeader){req.end();return}
      // The producer asynchronously writes 64 KiB chunks and waits for drain.
      void(async()=>{
        const bytes=Buffer.alloc(S5_HTTP_CHUNK_BYTES,0xa5);
        try{
          for(let offset=0;offset<bodyLength;offset+=S5_HTTP_CHUNK_BYTES){
            assertResources();
            const chunk=bytes.subarray(0,Math.min(S5_HTTP_CHUNK_BYTES,bodyLength-offset));
            digest.update(chunk);
            if(!req.write(chunk)){
              backpressureWrites++;
              await once(req,'drain',{signal:AbortSignal.timeout(5000)});
            }
          }
          req.end();
        }catch(e){req.destroy(error(e))}
      })();
    });
  };
  const close=async()=>{
    for(const req of active)req.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  };
  try{
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const large=Array.from({length:count},()=>localRequest('/mcp/large',size));
    // Avoid unhandled rejections if preflight cannot reach the barrier.
    const pending=Promise.all(large);
    void pending.catch(()=>{});
    await Promise.race([
      barrier,
      sleep(Math.min(limit,5000)).then(()=>{throw new Error('4-request barrier not reached')}),
    ]);
    // Probe fifth only while all 4 slots are occupied. Tests for <4 skip it.
    if(options.probeFifthRequest===true&&count===4){
      const fifth=await localRequest('/mcp/large',1);
      if(fifth.status!==429)throw new Error('Fifth large request was not rejected');
    }
    const small=await Promise.all(Array.from({length:smallCount},
      ()=>localRequest('/mcp/small',0)));
    for(const s of small){
      if(s.status!==200)throw new Error('Small MCP request starved or rejected');
      smallLatency.push(s.latency);
    }
    const completed=await pending;
    for(const l of completed){
      if(l.status!==200||!l.sha)throw new Error('Large fixture HTTP failed');
      largeLatency.push(l.latency);
    }
    if(options.probeOverLimit===true){
      // Header-only 413 check. Do not transmit 9.5 MiB+1 into the fixture.
      const over=await localRequest('/mcp/large',0,true);
      if(over.status!==413)throw new Error('Synthetic 413 header guard failed');
    }
    assertResources();
    return {
      classification:'REAL_LOCAL_HTTP_BYTES_SYNTHETIC_MCP_FIXTURE',
      configuredHttpBodyMaxBytes:S5_HTTP_MAX_BYTES,
      configuredLargeInFlightCap:4,
      largeSuccessful:largeOk,largePeakActive:largePeak,
      smallSuccessful:smallOk,smallArrivedDuringLarge:smallArrived,
      smallLatencyMs:{p50:pctl(smallLatency,.5),p95:pctl(smallLatency,.95),p99:pctl(smallLatency,.99)},
      largeLatencyMs:{p50:pctl(largeLatency,.5),p95:pctl(largeLatency,.95),p99:pctl(largeLatency,.99)},
      http413Count:rejected413,http429Count:rejected429,
      backpressureWrites,bytesReceived:networkBytes,
      receivedHashes:receiverHashes,
      rssGrowthPeakBytes:Math.max(0,rssPeak-rssStart),
      memoryBudgetBytes:budget,
      externalWssAuthenticated:0,actualNativeToolCompletions:0,cloudflareMeterReadings:null,
    };
  }finally{await close()}
}
