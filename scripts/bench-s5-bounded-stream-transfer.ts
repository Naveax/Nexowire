/**
 * S5/#588 LOCAL ONLY: actual TCP byte streaming; no Nexowire Artifact Store,
 * Agent file API, MCP attachment, Cloudflare or customer resource is touched.
 *
 * A live 1-GiB byte stream is transferred through 127.0.0.1 socket buffers,
 * with SHA-256 computed on both sides. NO 1-GiB disk/temp file is allocated.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer,createConnection,type Socket,type Server} from 'node:net';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';

const LOOPBACK='127.0.0.1';
export const S5_LOCAL_CHUNK_BYTES=65536;
export const S5_LOCAL_221_KIB=221*1024;
export const S5_LOCAL_OVER_256_MIB=256*1024*1024+1;
export const S5_LOCAL_1_GIB=1024*1024*1024;
export interface S5LocalStreamPlan {
  sizesBytes:readonly number[];
  chunkBytes?:number;
  maxConcurrent?:number;
  deadlineMs?:number;
  maxRssGrowthBytes?:number;
}
export interface S5LocalStreamSample {
  kind:'REAL_LOOPBACK_TCP_BYTES_NO_ARTIFACT_API';
  requestedBytes:number;
  transmittedBytes:number;
  receivedBytes:number;
  emittedChunks:number;
  senderSha256:string;
  receiverSha256:string;
  elapsedMs:number;
  throughputMiBps:number;
  backpressureEvents:number;
  backpressureStallMs:{p95:number;p99:number};
  rssPeakBytes:number;
  rssGrowthPeakBytes:number;
  cpuUserMs:number;
  cpuSystemMs:number;
  maxSocketWritableLengthBytes:number;
  completedNativeTools:0;
  actualArtifactStoreCommit:false;
}
export interface S5LocalStreamReport {
  classification:'LOCAL_STREAM_ONLY_NOT_NEXOWIRE_INGEST';
  maxConcurrent:number;
  peakActiveTransfers:number;
  observedRssBaselineBytes:number;
  observedRssPeakBytes:number;
  samples:S5LocalStreamSample[];
  stagingWssConnections:0;
  nativeToolCompletions:0;
  providerCountersMeasured:false;
  externalNetworkRequests:0;
  diskFileBytesCreated:0;
  constraints:readonly string[];
}
function boundedInteger(v:number,min:number,max:number,label:string){
  if(!Number.isSafeInteger(v)||v<min||v>max)throw new Error('Unbounded S5 load: '+label);
}
function percentile(values:number[],fraction:number){
  if(!values.length)return 0;
  const sorted=[...values].sort((a,b)=>a-b);
  return Number((sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)]??0).toFixed(3));
}
function mkFailure(error:unknown){return error instanceof Error?error:new Error(String(error))}
export async function runS5LocalStreamLoad(plan:S5LocalStreamPlan):Promise<S5LocalStreamReport>{
  if(!plan||!Array.isArray(plan.sizesBytes)||plan.sizesBytes.length<1||
     plan.sizesBytes.length>3)throw new Error('Invalid S5 scenario count');
  const maxConcurrent=plan.maxConcurrent??1;
  const chunkBytes=plan.chunkBytes??S5_LOCAL_CHUNK_BYTES;
  const deadlineMs=plan.deadlineMs??60000;
  const maxGrowth=plan.maxRssGrowthBytes??128*1024*1024;
  boundedInteger(maxConcurrent,1,2,'maxConcurrent');
  boundedInteger(chunkBytes,1024,S5_LOCAL_CHUNK_BYTES,'chunkBytes');
  boundedInteger(deadlineMs,1000,60000,'deadlineMs');
  boundedInteger(maxGrowth,16*1024*1024,256*1024*1024,'maxRssGrowthBytes');
  for(const size of plan.sizesBytes)boundedInteger(size,1,S5_LOCAL_1_GIB,'size');
  const total=plan.sizesBytes.reduce((sum,n)=>sum+n,0);
  boundedInteger(total,1,S5_LOCAL_1_GIB+S5_LOCAL_OVER_256_MIB+S5_LOCAL_221_KIB,
    'total transfer bytes');
  const rssStart=process.memoryUsage().rss;
  let rssPeak=rssStart;
  let active=0,peakActive=0;
  const sockets=new Set<Socket>();
  const servers=new Set<Server>();
  const updatePeak=()=>{
    rssPeak=Math.max(rssPeak,process.memoryUsage().rss);
    if(rssPeak-rssStart>maxGrowth)throw new Error('S5 memory safety budget exhausted');
  };
  const abortAll=()=>{
    for(const socket of sockets)socket.destroy();
    for(const server of servers)server.close();
  };
  const doOne=async(size:number,index:number):Promise<S5LocalStreamSample>=>{
    const begin=performance.now(),cpuBegin=process.cpuUsage();
    const receivedHash=createHash('sha256'),sendHash=createHash('sha256');
    let received=0,sent=0,frames=0,backpressure=0,maxWritable=0,done=false;
    const stalls:number[]=[];
    const buffer=Buffer.alloc(chunkBytes,(index*37+size%251)%256);
    let server:Server|undefined,client:Socket|undefined;
    let resolveReceive!:(v:string)=>void,rejectReceive!:(e:Error)=>void;
    const receivedPromise=new Promise<string>((resolve,reject)=>{
      resolveReceive=resolve;rejectReceive=reject;
    });
    // Prevent the rejecting receiver future from becoming unhandled during
    // an interrupted sender path.
    void receivedPromise.catch(()=>{});
    try{
      server=createServer(socket=>{
        sockets.add(socket);
        socket.on('data',(data:Buffer)=>{
          received+=data.byteLength;
          if(received>size){rejectReceive(new Error('Received too many bytes'));socket.destroy();return}
          receivedHash.update(data);
          if(received% (16*1024*1024)===0) {
            try{updatePeak()}catch(e){rejectReceive(mkFailure(e));socket.destroy()}
          }
        });
        socket.once('end',()=>{
          if(received!==size){rejectReceive(new Error('Incomplete receiver stream'));return}
          done=true;resolveReceive(receivedHash.digest('hex'));
        });
        socket.once('error',error=>{if(!done)rejectReceive(error)});
        socket.once('close',()=>sockets.delete(socket));
      });
      servers.add(server);
      server.listen(0,LOOPBACK);
      await once(server,'listening');
      const endpoint=server.address();
      if(!endpoint||typeof endpoint==='string')throw new Error('No local TCP port');
      client=createConnection({host:LOOPBACK,port:endpoint.port});
      sockets.add(client);
      await once(client,'connect');
      const deadline=performance.now()+deadlineMs;
      for(let offset=0;offset<size;offset+=chunkBytes){
        if(performance.now()>deadline)throw new Error('S5 local transfer deadline exceeded');
        const count=Math.min(chunkBytes,size-offset);
        const payload=count===chunkBytes?buffer:buffer.subarray(0,count);
        sendHash.update(payload);
        sent+=count;frames++;
        const writeAccepted=client.write(payload);
        maxWritable=Math.max(maxWritable,client.writableLength);
        if(!writeAccepted){
          backpressure++;
          const stallStart=performance.now();
          // Error and early close are propagated through the socket stream.
          await once(client,'drain',{signal:AbortSignal.timeout(Math.min(5000,deadlineMs))});
          const stalled=performance.now()-stallStart;
          if(stalls.length<65536)stalls.push(stalled);
        }
        if(frames%128===0)updatePeak();
      }
      client.end();
      const hash=await receivedPromise;
      assert.equal(received,size);
      assert.equal(sent,size);
      const expected=sendHash.digest('hex');
      assert.equal(hash,expected,'End-to-end local stream SHA256 mismatch');
      updatePeak();
      const elapsed=performance.now()-begin,cpu=process.cpuUsage(cpuBegin);
      return {
        kind:'REAL_LOOPBACK_TCP_BYTES_NO_ARTIFACT_API',requestedBytes:size,
        transmittedBytes:sent,receivedBytes:received,emittedChunks:frames,
        senderSha256:expected,receiverSha256:hash,
        elapsedMs:Number(elapsed.toFixed(3)),
        throughputMiBps:Number(((received/1048576)/(elapsed/1000)).toFixed(3)),
        backpressureEvents:backpressure,
        backpressureStallMs:{p95:percentile(stalls,.95),p99:percentile(stalls,.99)},
        rssPeakBytes:rssPeak,
        rssGrowthPeakBytes:Math.max(0,rssPeak-rssStart),
        cpuUserMs:cpu.user/1000,cpuSystemMs:cpu.system/1000,
        maxSocketWritableLengthBytes:maxWritable,
        completedNativeTools:0,actualArtifactStoreCommit:false,
      };
    }catch(error){
      abortAll();
      throw mkFailure(error);
    }finally{
      if(client){client.destroy();sockets.delete(client)}
      if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
      if(server)servers.delete(server);
    }
  };
  const results=new Array<S5LocalStreamSample>(plan.sizesBytes.length);
  let next=0;
  try{
    const workers=Array.from({length:Math.min(maxConcurrent,plan.sizesBytes.length)},async()=>{
      for(;;){
        const i=next++;
        if(i>=plan.sizesBytes.length)return;
        active++;peakActive=Math.max(peakActive,active);
        try{results[i]=await doOne(plan.sizesBytes[i]!,i)}
        finally{active--}
      }
    });
    await Promise.all(workers);
    return {
      classification:'LOCAL_STREAM_ONLY_NOT_NEXOWIRE_INGEST',maxConcurrent,
      peakActiveTransfers:peakActive,observedRssBaselineBytes:rssStart,
      observedRssPeakBytes:rssPeak,samples:results,
      stagingWssConnections:0,nativeToolCompletions:0,
      providerCountersMeasured:false,externalNetworkRequests:0,
      diskFileBytesCreated:0,
      constraints:[
        'Actual bytes cross TCP loopback, but NOT authenticated WSS nor Nexowire Agent/Hub artifact API',
        'Memory safety guards, local-only binding, limited chunks, zero 1-GiB temp files',
        'No resumable artifact, owner grant, storage quota or native tool completion is verified',
        'Cloudflare request/egress/billing values remain unknown; this benchmark is not production acceptance',
      ],
    };
  }finally{abortAll()}
}
