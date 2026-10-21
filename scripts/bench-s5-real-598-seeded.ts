/**
 * #15: bounded REAL #598 Express parser benchmark, localhost ONLY.
 * No Hub, Agent, public WSS, Cloudflare, token, production host or physical files.
 * Four fixed-seed, incremental JSON HTTP bodies; no >64 KiB producer buffer.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer,request,type ClientRequest} from 'node:http';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {gzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {createNexowireMcpExpressApp,NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES}
  from '../src/mcp/http-app.js';

export const S5_SEED=0x5a17c0de;
const HOST='127.0.0.1';
const CHUNK=65536;
const BODY_MIN=256*1024;
const SMALL_N=20;
const ASCII='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
type Observed={status:number;durationMs:number;data:Record<string,unknown>|null};
export type S5ParserEvidence=Readonly<{
  kind:'S5_REAL_598_EXPRESS_LOCAL_PARSER_NO_NATIVE';
  seed:number;sourceBodyBytes:number;largeCount:4;
  receivedBytes:number;largeSha256:string[];largeSuccesses:number;
  smallSuccesses:number;smallDuringLarge:20;
  smallLatency:{method:'nearest-rank';clock:'performance.now';successN:number;attemptedN:number;p50:number;p95:number;p99:number};
  largeLatency:{method:'nearest-rank';clock:'performance.now';successN:number;attemptedN:number;p50:number;p95:number;p99:number};
  fifthBusy503:number;gzipBusy503:number;gzipAfterRelease200:number;gzipInflatedOversize413:number;
  backpressureDrainEvents:number;rssGrowthPeakBytes:number;rssGrowthLimitBytes:number;
  cpuUserUs:number;cpuSystemUs:number;wallDurationMs:number;
  actualNativeToolCompletions:0;authenticatedPublicWss:0;actualCloudflareCost:null;
  oneGiBPhysicalFiles:0;productionAcceptance:'NO_GO';
}>;

function xorshift(seed:number) {
  let s=seed>>>0;
  return ()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return s>>>0;};
}
function chunkOf(next:()=>number,size:number):Buffer{
  const b=Buffer.allocUnsafe(size);
  for(let i=0;i<size;i++)b[i]=ASCII.charCodeAt(next()&63);
  return b;
}
export function s5NearestRank(xs:readonly number[],p:number){
  if(xs.length===0||!(p>0&&p<=1)||xs.some(x=>!Number.isFinite(x)||x<0))
    throw Error('S5_INVALID_LATENCY_SAMPLE');
  const ordered=[...xs].sort((a,b)=>a-b);
  return Number(ordered[Math.ceil(p*ordered.length)-1]!.toFixed(3));
}
const quantiles=(values:number[],attempted:number)=>({
  method:'nearest-rank' as const,clock:'performance.now' as const,
  successN:values.length,attemptedN:attempted,
  p50:s5NearestRank(values,.5),p95:s5NearestRank(values,.95),
  p99:s5NearestRank(values,.99),
});

export async function runS5RealParserSeeded(options:{bodyBytes:number;rssGrowthLimitBytes?:number}):Promise<S5ParserEvidence>{
  if(!options||![BODY_MIN,NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES].includes(options.bodyBytes))
    throw Error('S5_UNBOUNDED_BODY');
  const rssLimit=options.rssGrowthLimitBytes??256*1024*1024;
  if(!Number.isSafeInteger(rssLimit)||rssLimit<128*1024*1024||rssLimit>320*1024*1024)
    throw Error('S5_UNBOUNDED_RSS');
  const started=performance.now(),cpuBefore=process.cpuUsage(),rssBefore=process.memoryUsage().rss;
  let peak= rssBefore,exceeded=false,bytes=0,drainEvents=0,arrived=0;
  const samplesSmall:number[]=[],samplesLarge:number[]=[];
  const receivedSha:string[]=[];
  const active:ClientRequest[]=[];
  const app=createNexowireMcpExpressApp({host:HOST,allowedHosts:[HOST,'localhost']});
  app.post('/mcp',(req,res)=>{
    const payload=req.body?.payload;
    if(typeof payload==='string'){
      bytes+=Buffer.byteLength(payload);
      const sha=createHash('sha256').update(payload).digest('hex');
      receivedSha.push(sha);
      res.json({bytes:payload.length,sha});
    }else res.json({ok:true});
  });
  const server=createServer(app);
  let arrive!:()=>void;
  const fourArrived=new Promise<void>(resolve=>{arrive=resolve;});
  server.on('request',req=>{
    if(req.headers['x-s5-upload']==='seeded'){arrived++;if(arrived===4)arrive();}
  });
  const observe=()=>{
    peak=Math.max(peak,process.memoryUsage().rss);
    if(peak-rssBefore>rssLimit){
      exceeded=true;
      for(const r of active)r.destroy(new Error('S5_RSS_BUDGET_EXCEEDED'));
      server.closeAllConnections();
    }
  };
  const sampler=setInterval(observe,10);
  let listen=false;
  try{
    server.listen(0,HOST);await once(server,'listening');listen=true;
    const addr=server.address();
    assert.ok(addr&&typeof addr!=='string');
    const port=addr.port,url='http://'+HOST+':'+port+'/mcp';
    const post=async(body:string|Uint8Array,encoding?:string):Promise<Observed>=>{
      const before=performance.now();
      const res=await fetch(url,{method:'POST',signal:AbortSignal.timeout(7000),
        headers:{'content-type':'application/json',...(encoding?{'content-encoding':encoding}:{})},
        body:typeof body==='string'?body:new Uint8Array(body)});
      const raw=await res.text();
      if(raw.length>4096)throw Error('S5_RESPONSE_TOO_LARGE');
      let payload:Record<string,unknown>|null=null;
      try {payload=JSON.parse(raw) as Record<string,unknown>;} catch {
        if(res.status!==413)throw Error('S5_UNEXPECTED_NON_JSON_RESPONSE');
        // Current #598 Express default error handler may return HTML for 413.
      }
      observe();
      return {status:res.status,durationMs:performance.now()-before,data:payload};
    };
    const HEADER='{"payload":"',TAIL='"}';
    const payloadBytes=options.bodyBytes-Buffer.byteLength(HEADER)-Buffer.byteLength(TAIL);
    assert.ok(payloadBytes>0);
    const writers:Array<{req:ClientRequest;hash:ReturnType<typeof createHash>;next:()=>number;response:Promise<Observed>;begin:number}>=[];
    for(let i=0;i<4;i++){
      const begin=performance.now();
      let resolve!: (v:Observed)=>void,reject!:(error:Error)=>void;
      const response=new Promise<Observed>((a,b)=>{resolve=a;reject=b;});
      void response.catch(()=>{});
      const writer=request({hostname:HOST,port,path:'/mcp',method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':options.bodyBytes,
          'x-s5-upload':'seeded'}},async res=>{
        try{
          const content:string[]=[];
          for await(const part of res){
            content.push(Buffer.from(part).toString('utf8'));
            if(content.join('').length>1024)throw Error('S5_RESPONSE_TOO_LARGE');
          }
          resolve({status:res.statusCode??0,durationMs:performance.now()-begin,
            data:JSON.parse(content.join('')) as Record<string,unknown>});
        }catch(e){reject(e instanceof Error?e:Error(String(e)));}
      });
      writer.setTimeout(15000,()=>writer.destroy(Error('S5_HTTP_TIMEOUT')));
      writer.once('error',reject);
      active.push(writer);
      const hash=createHash('sha256'),next=xorshift(S5_SEED^(i+1)*0x9e3779b9);
      writers.push({req:writer,hash,next,response,begin});
      writer.write(HEADER); // actual parser begins, remainder intentionally held
    }
    await Promise.race([fourArrived,delay(4500).then(()=>{throw Error('S5_PARSER_ARRIVAL_TIMEOUT')})]);
    assert.equal(arrived,4);
    const small=await Promise.all(Array.from({length:SMALL_N},()=>post('{"ping":true}')));
    for(const x of small){assert.equal(x.status,200);assert.equal(x.data?.ok,true);samplesSmall.push(x.durationMs);}
    const bomb=gzipSync(Buffer.from(JSON.stringify({payload:'G'.repeat(2*1024*1024)})));
    assert.ok(bomb.byteLength<100*1024);
    const gzipBusy=await post(new Uint8Array(bomb),'gzip');
    assert.equal(gzipBusy.status,503);assert.equal(gzipBusy.data?.code,'MCP_JSON_PARSER_BUSY');
    const fifth=await post(JSON.stringify({payload:'a'.repeat(128*1024)}));
    assert.equal(fifth.status,503);assert.equal(fifth.data?.code,'MCP_JSON_PARSER_BUSY');
    // Release all four parser slots with full size compliant seeded bodies.
    await Promise.all(writers.map(async w=>{
      let remaining=payloadBytes;
      while(remaining>0){
        if(exceeded)throw Error('S5_RSS_BUDGET_EXCEEDED');
        const chunk=chunkOf(w.next,Math.min(CHUNK,remaining));
        w.hash.update(chunk);remaining-=chunk.length;
        if(!w.req.write(chunk)){
          drainEvents++;
          await once(w.req,'drain',{signal:AbortSignal.timeout(5000)});
        }
        observe();
      }
      w.req.end(TAIL);
    }));
    const all=await Promise.all(writers.map(w=>w.response));
    for(let i=0;i<4;i++){
      const got=all[i]!,want=writers[i]!.hash.digest('hex');
      assert.equal(got.status,200);assert.equal(got.data?.bytes,payloadBytes);
      assert.equal(got.data?.sha,want);samplesLarge.push(got.durationMs);
    }
    assert.equal(receivedSha.length,4);
    assert.equal(bytes,4*payloadBytes);
    // Snapshot the four large transfers BEFORE the subsequent gzip probe,
    // whose successful parse is a distinct fifth fixture request.
    const fourLargeHashes=[...receivedSha];
    const gzipOk=await post(new Uint8Array(bomb),'gzip');
    assert.equal(gzipOk.status,200);assert.equal(gzipOk.data?.bytes,2*1024*1024);
    const oversized=gzipSync(Buffer.from(JSON.stringify({payload:'H'.repeat(NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES)})));
    assert.ok(oversized.length<100*1024);
    const gzipOver=await post(new Uint8Array(oversized),'gzip');
    assert.equal(gzipOver.status,413);
    observe();
    if(exceeded)throw Error('S5_RSS_BUDGET_EXCEEDED');
    const cpu=process.cpuUsage(cpuBefore);
    return {kind:'S5_REAL_598_EXPRESS_LOCAL_PARSER_NO_NATIVE',seed:S5_SEED,
      sourceBodyBytes:options.bodyBytes,largeCount:4,
      receivedBytes:4*options.bodyBytes,largeSha256:fourLargeHashes,largeSuccesses:4,
      smallSuccesses:SMALL_N,smallDuringLarge:20,
      smallLatency:quantiles(samplesSmall,SMALL_N),
      largeLatency:quantiles(samplesLarge,4),
      fifthBusy503:1,gzipBusy503:1,gzipAfterRelease200:1,gzipInflatedOversize413:1,
      backpressureDrainEvents:drainEvents,
      rssGrowthPeakBytes:Math.max(0,peak-rssBefore),rssGrowthLimitBytes:rssLimit,
      cpuUserUs:cpu.user,cpuSystemUs:cpu.system,wallDurationMs:Number((performance.now()-started).toFixed(3)),
      actualNativeToolCompletions:0,authenticatedPublicWss:0,actualCloudflareCost:null,
      oneGiBPhysicalFiles:0,productionAcceptance:'NO_GO'};
  }finally{
    clearInterval(sampler);
    for(const r of active)r.destroy();
    if(listen){
      server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  }
}
