import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import type {Socket} from 'node:net';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';
import {
  advanceProposedOwnerWssBoundedTransfer,
  OWNER_WSS_CHUNK_BYTES,
  type OwnerWssChunkAck,type OwnerWssChunkFrame,
  type OwnerWssStreamDependencies,type OwnerWssTransferScope,
} from '../src/product/owner-public-wss-stream-flow-proposal.js';

/** Loopback-only TLS1.3 WSS transport fixture, never a public Hub path. */
const SCOPE:OwnerWssTransferScope={
  ownerId:'owner-physical-01',deviceId:'device-physical-01',
  projectId:'project-wss-01',sessionId:'session-wss-01',
};
const MAX_WIRE=OWNER_WSS_CHUNK_BYTES+1024;
const SHA='1'.repeat(64);
const SOURCE_ID='fixture-source-id-001';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function fixtureCert(){
  const dir=mkdtempSync(path.join(tmpdir(),'s2-wss-tls-test-'));
  const cert=path.join(dir,'cert.pem');
  const key=path.join(dir,'key.pem');
  try{
    execFileSync('openssl',[
      'req','-x509','-newkey','rsa:2048','-nodes',
      '-keyout',key,'-out',cert,'-days','1',
      '-subj','/CN=127.0.0.1',
      '-addext','subjectAltName=IP:127.0.0.1',
    ],{stdio:'ignore',timeout:20000});
  }catch(e){
    rmSync(dir,{recursive:true,force:true});
    throw e;
  }
  return {cert:readFileSync(cert),key:readFileSync(key),
    close(){rmSync(dir,{recursive:true,force:true})}};
}
async function serverFixture(totalBytes:number,dropAck=false){
  const certificates=fixtureCert();
  const server=createServer({
    cert:certificates.cert,key:certificates.key,
    minVersion:'TLSv1.3',maxVersion:'TLSv1.3',
  },(_req,res)=>{res.writeHead(404);res.end()});
  const socketServer=new WebSocketServer({
    noServer:true,maxPayload:MAX_WIRE,perMessageDeflate:false,
  });
  let committed=0,wireFrames=0,largestFrame=0,dropped=false;
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!=='/s2-transfer-fixture'||
      (socket as Socket).remoteAddress!=='127.0.0.1'){
      socket.destroy();return;
    }
    socketServer.handleUpgrade(req,socket,head,client=>{
      socketServer.emit('connection',client,req);
    });
  });
  socketServer.on('connection',client=>{
    // A rejected oversized frame emits an expected parser error first.
    client.on('error',()=>{});
    client.on('message',(wire,binary)=>{
      if(!binary){client.close(1008,'binary only');return}
      const bytes=Buffer.from(wire as Buffer);
      wireFrames++;
      largestFrame=Math.max(largestFrame,bytes.length);
      if(bytes.length<5||bytes.length>MAX_WIRE){
        client.close(1009,'large');return;
      }
      const headerSize=bytes.readUInt32BE(0);
      if(headerSize<1||headerSize>1024||
        bytes.length<4+headerSize){
        client.close(1008,'header');return;
      }
      let header:Omit<OwnerWssChunkFrame,'bytes'>;
      try{
        header=JSON.parse(bytes.subarray(4,4+headerSize).toString()) as
          Omit<OwnerWssChunkFrame,'bytes'>;
      }catch{client.close(1008,'json');return}
      const chunk=bytes.subarray(4+headerSize);
      if(Object.keys(SCOPE).some(k=>
        header[k as keyof OwnerWssTransferScope] !==
        SCOPE[k as keyof OwnerWssTransferScope])||
        header.sourceSha256!==SHA||header.revision!==5||
        header.offset!==committed||
        header.totalBytes!==totalBytes||
        chunk.length<1||chunk.length>OWNER_WSS_CHUNK_BYTES||
        committed+chunk.length>totalBytes||
        sha(chunk)!==header.chunkSha256){
        client.close(1008,'scope or chunk mismatch');return;
      }
      committed+=chunk.length;
      if(dropAck&&!dropped){dropped=true;return}
      client.send(JSON.stringify({
        ...SCOPE,revision:5,sourceSha256:SHA,committedOffset:committed,
      }));
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const addr=server.address();
  if(!addr||typeof addr==='string')throw new Error('local server address unavailable');
  const url='wss://127.0.0.1:'+addr.port+'/s2-transfer-fixture';
  async function dial(){
    const socket=new WebSocket(url,{
      rejectUnauthorized:true,ca:certificates.cert,
      minVersion:'TLSv1.3',maxVersion:'TLSv1.3',
      perMessageDeflate:false,maxPayload:MAX_WIRE,
    });
    await new Promise<void>((resolve,reject)=>{
      socket.once('open',()=>resolve());
      socket.once('error',reject);
    });
    return socket;
  }
  function dependencies(socket:WebSocket):OwnerWssStreamDependencies{
    return {
      async readGrant(){return {...SCOPE,status:'active',
        revision:5,totalBytes,sourceIdentity:SOURCE_ID,sourceSha256:SHA}},
      async readReceipt(){return {...SCOPE,revision:5,
        committedOffset:committed,sourceSha256:SHA}},
      async sourceSnapshot(){return {
        totalBytes,sourceIdentity:SOURCE_ID,sourceSha256:SHA,
      }},
      async readSource(offset,length){return Buffer.alloc(length,
        Math.floor(offset/OWNER_WSS_CHUNK_BYTES)&255)},
      bufferedAmount(){return socket.bufferedAmount},
      async sendChunk(frame){
        const header=Buffer.from(JSON.stringify({
          ownerId:frame.ownerId,deviceId:frame.deviceId,
          projectId:frame.projectId,sessionId:frame.sessionId,
          revision:frame.revision,offset:frame.offset,
          totalBytes:frame.totalBytes,sourceSha256:frame.sourceSha256,
          chunkSha256:frame.chunkSha256,
        }));
        const wire=Buffer.alloc(4+header.length+frame.bytes.byteLength);
        wire.writeUInt32BE(header.length,0);
        header.copy(wire,4);
        Buffer.from(frame.bytes).copy(wire,4+header.length);
        assert.ok(wire.byteLength<=MAX_WIRE);
        return await new Promise<OwnerWssChunkAck>((resolve,reject)=>{
          let closed=false;
          const done=(error?:Error,data?:OwnerWssChunkAck)=>{
            if(closed)return;
            closed=true;
            clearTimeout(timeout);
            socket.off('message',onMessage);
            socket.off('close',onClose);
            socket.off('error',onError);
            if(error)reject(error);
            else if(data)resolve(data);
            else reject(new Error('WSS missing ACK'));
          };
          const onMessage=(raw:WebSocket.RawData)=>{
            try{done(undefined,JSON.parse(raw.toString()))}
            catch{done(new Error('bad ACK'))}
          };
          const onClose=()=>done(new Error('disconnected'));
          const onError=(e:Error)=>done(e);
          const timeout=setTimeout(()=>done(new Error('ACK timeout')),150);
          socket.once('message',onMessage);
          socket.once('close',onClose);
          socket.once('error',onError);
          socket.send(wire,{binary:true},err=>{if(err)done(err)});
        });
      },
    };
  }
  async function close(){
    for(const socket of socketServer.clients)socket.terminate();
    await new Promise<void>(resolve=>socketServer.close(()=>resolve()));
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    certificates.close();
  }
  return {dial,dependencies,close,get committed(){return committed},
    get wireFrames(){return wireFrames},
    get largestFrame(){return largestFrame}};
}
test('real TLS1.3 loopback WSS uses bounded binary frames for 221 KiB',
  {timeout:20000},async()=>{
    const f=await serverFixture(221*1024);
    let socket:WebSocket|undefined;
    try{
      socket=await f.dial();
      const result=await advanceProposedOwnerWssBoundedTransfer(
        SCOPE,f.dependencies(socket),
      );
      assert.equal(result.state,'COMPLETE');
      assert.equal(f.committed,221*1024);
      assert.equal(f.wireFrames,4);
      assert.ok(f.largestFrame<=MAX_WIRE);
      assert.ok(f.largestFrame>OWNER_WSS_CHUNK_BYTES);
    }finally{
      socket?.terminate();
      await f.close();
    }
  });
test('real WSS dropped ACK cannot auto-replay; second socket resumes by durable receipt',
  {timeout:20000},async()=>{
    const f=await serverFixture(2*OWNER_WSS_CHUNK_BYTES,true);
    let first:WebSocket|undefined,second:WebSocket|undefined;
    try{
      first=await f.dial();
      const unknown=await advanceProposedOwnerWssBoundedTransfer(
        SCOPE,f.dependencies(first),
      );
      assert.equal(unknown.state,'UNKNOWN');
      assert.equal(unknown.autoReplayAllowed,false);
      assert.equal(f.committed,OWNER_WSS_CHUNK_BYTES);
      first.terminate();
      second=await f.dial();
      const resumed=await advanceProposedOwnerWssBoundedTransfer(
        SCOPE,f.dependencies(second),
      );
      assert.equal(resumed.state,'COMPLETE');
      assert.equal(f.wireFrames,2);
      assert.equal(f.committed,2*OWNER_WSS_CHUNK_BYTES);
    }finally{
      first?.terminate();second?.terminate();
      await f.close();
    }
  });

test('actual WebSocket payload beyond per-frame cap is rejected before any commit',
  {timeout:20000},async()=>{
    const f=await serverFixture(1_073_741_824);
    let client:WebSocket|undefined;
    try{
      client=await f.dial();
      const socket=client;
      const closed=new Promise<number>((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('oversized WSS not rejected')),3000);
        socket.once('close',code=>{clearTimeout(timeout);resolve(code)});
        socket.once('error',()=>{});
      });
      socket.send(Buffer.alloc(MAX_WIRE+4096),{binary:true});
      const code=await closed;
      assert.ok(code===1009||code===1006);
      assert.equal(f.committed,0);
      assert.equal(f.wireFrames,0);
    }finally{
      client?.terminate();
      await f.close();
    }
  });
test('WSS server rejects signed-frame device/project scope mismatch without commit',
  {timeout:20000},async()=>{
    const f=await serverFixture(1024);
    let socket:WebSocket|undefined;
    try{
      socket=await f.dial();
      const invalid={...SCOPE,deviceId:'other-device-123',
        revision:5,offset:0,totalBytes:1024,sourceSha256:SHA,
        chunkSha256:sha(Buffer.alloc(1024))};
      const header=Buffer.from(JSON.stringify(invalid));
      const frame=Buffer.alloc(4+header.length+1024);
      frame.writeUInt32BE(header.length,0);header.copy(frame,4);
      const client=socket;
      const closed=new Promise<number>((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('scope mismatch not rejected')),3000);
        client.once('close',code=>{clearTimeout(timeout);resolve(code)});
        client.once('error',()=>{});
      });
      client.send(frame,{binary:true});
      assert.equal(await closed,1008);
      assert.equal(f.committed,0);
    }finally{
      socket?.terminate();
      await f.close();
    }
  });