/**
 * DEV-only local TCP/WebSocket reconnect storm and bounded backpressure fixture.
 * No native effect, no Cloudflare, no WSS identity, no production hostname.
 */
import assert from 'node:assert/strict';
import WebSocket,{WebSocketServer} from 'ws';
import {setImmediate as nextTurn,setTimeout as sleep} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';

export interface S5ReconnectStormResult{
  kind:'SYNTHETIC_LOOPBACK_WS_NO_REAL_NATIVE_TOOL';
  socketsPerRound:number;rounds:number;opened:number;closed:number;peakOpen:number;
  requests:number;uniqueReservations:number;duplicates:number;backpressure:number;
  peakQueue:number;peakProcessing:number;
  latencyMs:{p50:number;p95:number;p99:number};
  reportedNativeCompleted:0;verifiedNativeCompleted:0;
}
export async function runS5ReconnectStorm(input:{socketsPerRound:number;rounds:number;queueLimit:number;processingLimit:number}):
  Promise<S5ReconnectStormResult>{
  const {socketsPerRound,rounds,queueLimit,processingLimit}=input;
  if(!Number.isSafeInteger(socketsPerRound)||socketsPerRound<1||socketsPerRound>128||
     !Number.isSafeInteger(rounds)||rounds<1||rounds>3||
     !Number.isSafeInteger(queueLimit)||queueLimit<1||queueLimit>128||
     !Number.isSafeInteger(processingLimit)||processingLimit<1||processingLimit>8){
    throw new Error('S5 storm safety limits exceeded');
  }
  let server:WebSocketServer|undefined;
  const clients=new Set<WebSocket>();
  const serverSockets=new Set<WebSocket>();
  const previous=new Set<string>();
  const queue:Array<{ws:WebSocket;id:string}>=[];
  const latencies:number[]=[];
  let opened=0,closed=0,peakOpen=0,peakQueue=0,peakProcessing=0;
  let active=0,requests=0,uniqueReservations=0,duplicates=0,backpressure=0;
  try{
    server=new WebSocketServer({host:'127.0.0.1',port:0,perMessageDeflate:false,maxPayload:512});
    const send=(ws:WebSocket,id:string,status:string)=>{
      if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({id,status,authorizesToolExecution:false}));
    };
    const drain=()=>{
      while(active<processingLimit&&queue.length){
        const item=queue.shift()!;active++;peakProcessing=Math.max(peakProcessing,active);
        void(async()=>{
          try{
            await nextTurn();
            if(previous.has(item.id)){duplicates++;send(item.ws,item.id,'duplicate')}
            else{previous.add(item.id);uniqueReservations++;send(item.ws,item.id,'reserved')}
          }finally{active--;drain()}
        })();
      }
    };
    server.on('connection',ws=>{
      opened++;serverSockets.add(ws);peakOpen=Math.max(peakOpen,serverSockets.size);
      ws.on('close',()=>{serverSockets.delete(ws);closed++});
      ws.on('message',data=>{
        requests++;
        let id:string;
        try{
          const msg=JSON.parse(data.toString()) as {id:unknown};
          if(typeof msg.id!=='string'||!/^fixture-storm-\d{1,3}-\d{1,3}$/.test(msg.id)){
            throw new Error('Untrusted request ID');
          }
          id=msg.id;
        }catch{send(ws,'invalid','bad-request');return}
        if(queue.length>=queueLimit){backpressure++;send(ws,id,'backpressure');return}
        queue.push({ws,id});peakQueue=Math.max(peakQueue,queue.length);drain();
      });
    });
    if(!server.address()){
      await new Promise<void>((resolve,reject)=>{
        server!.once('listening',resolve);server!.once('error',reject);
      });
    }
    const address=server.address();
    if(!address||typeof address==='string')throw new Error('Not ephemeral loopback TCP');
    const url='ws://127.0.0.1:'+address.port;
    // All previous invocation IDs are deliberately replayed on reconnection.
    for(let round=0;round<rounds;round++){
      for(let start=0;start<socketsPerRound;start+=12){
        const sockets:WebSocket[]=[];
        for(let i=start;i<Math.min(start+12,socketsPerRound);i++){
          const ws=new WebSocket(url,{perMessageDeflate:false,handshakeTimeout:5000});
          clients.add(ws);sockets.push(ws);
        }
        await Promise.all(sockets.map(ws=>new Promise<void>((resolve,reject)=>{
          if(ws.readyState===WebSocket.OPEN)return resolve();
          ws.once('open',resolve);ws.once('error',reject);
        })));
        const attempts=sockets.map((ws,j)=>new Promise<void>((resolve,reject)=>{
          const clientIndex=start+j;
          // 0th round uses one unique invocation per socket.
          // Later rounds resend first round IDs and must not double-admit.
          const id='fixture-storm-'+clientIndex+'-0';
          const begin=performance.now();
          const timeout=setTimeout(()=>{ws.off('message',onMessage);reject(new Error('Storm RPC timeout'))},10000);
          const onMessage=(data:WebSocket.RawData)=>{
            try{
              const payload=JSON.parse(data.toString()) as {id:string;status:string;authorizesToolExecution:boolean};
              assert.equal(payload.id,id);assert.equal(payload.authorizesToolExecution,false);
              assert.ok(['reserved','duplicate','backpressure'].includes(payload.status));
              latencies.push(performance.now()-begin);
              clearTimeout(timeout);resolve();
            }catch(e){clearTimeout(timeout);reject(e)}
          };
          ws.once('message',onMessage);
          ws.send(JSON.stringify({id}));
        }));
        await Promise.all(attempts);
        await Promise.all(sockets.map(ws=>new Promise<void>(resolve=>{
          const timeout=setTimeout(()=>{ws.terminate();resolve()},1000);
          ws.once('close',()=>{clearTimeout(timeout);resolve()});
          ws.close(1000,'fixture-rotate');
        })));
        sockets.forEach(ws=>clients.delete(ws));
      }
    }
    // Client close completion can precede server close delivery on loopback.
    // Wait only for owned fixture sockets, with a strict bounded deadline.
    for(let i=0;i<50&&serverSockets.size>0;i++)await sleep(10);
    assert.equal(serverSockets.size,0);
    assert.equal(active,0);
    assert.equal(queue.length,0);
    assert.equal(opened,closed);
    assert.equal(requests,uniqueReservations+duplicates+backpressure);
    latencies.sort((a,b)=>a-b);
    const q=(rate:number)=>Number((latencies[Math.max(0,Math.ceil(latencies.length*rate)-1)]??0).toFixed(3));
    return {kind:'SYNTHETIC_LOOPBACK_WS_NO_REAL_NATIVE_TOOL',socketsPerRound,rounds,opened,closed,
      peakOpen,requests,uniqueReservations,duplicates,backpressure,peakQueue,peakProcessing,
      latencyMs:{p50:q(.5),p95:q(.95),p99:q(.99)},
      reportedNativeCompleted:0,verifiedNativeCompleted:0};
  }finally{
    for(const ws of clients)try{ws.terminate()}catch{}
    for(const ws of serverSockets)try{ws.terminate()}catch{}
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
  }
}
