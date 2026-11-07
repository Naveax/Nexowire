import {createHash} from 'node:crypto';
import {request,type IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';

const WS_MAGIC='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PENDING_BYTES=1024*1024;
function containsToken(value:string|undefined,token:string):boolean {
  return typeof value==='string'&&value.toLowerCase().split(',').some(part=>part.trim()===token);
}
function validKey(value:unknown):value is string {
  if(typeof value!=='string'||!/^[A-Za-z0-9+/]{22}==$/.test(value))return false;
  return Buffer.from(value,'base64').length===16 &&
    Buffer.from(value,'base64').toString('base64')===value;
}

/** Fixed loopback /agent bridge. Only the actual Hub may authorize a 101.
 *  The Hub must enforce remote-only device credentials and its admission
 *  contract; the bridge never substitutes a shared token or external target. */
export function bridgeLocalAgentUpgrade(req:IncomingMessage,socket:Duplex,head:Buffer,
  hubPort:number,onClose:()=>void):void {
  let peer:Duplex|undefined;
  let closed=false;
  let upgraded=false;
  let timer:NodeJS.Timeout|undefined;
  let upstream:ReturnType<typeof request>|undefined;
  const cleanup=(destroyClient:boolean)=>{
    if(closed)return;
    closed=true;
    clearTimeout(timer);
    peer?.destroy();
    upstream?.destroy();
    if(destroyClient)socket.destroy();
    onClose();
  };
  const fail=(status=401)=>{
    if(closed)return;
    // Flush a valid HTTP refusal before tearing down the client socket.
    cleanup(false);
    if(!socket.destroyed) {
      socket.end('HTTP/1.1 '+status+' Connection Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        ()=>socket.destroy());
    }
  };
  socket.once('error',()=>cleanup(true));
  socket.once('close',()=>cleanup(true));
  socket.once('end',()=>cleanup(true));

  const key=req.headers['sec-websocket-key'];
  const authorization=req.headers.authorization;
  if(req.method!=='GET'||req.url!=='/agent'||
      !containsToken(req.headers.connection,'upgrade')||
      req.headers.upgrade?.toLowerCase()!=='websocket'||
      !authorization||!/^Bearer nwx_dev_[A-Za-z0-9_-]{1,490}$/.test(authorization)||
      !validKey(key)||req.headers['sec-websocket-version']!=='13'||
      head.length>65536){
    fail(401);
    return;
  }
  const accept=createHash('sha1').update(key+WS_MAGIC).digest('base64');
  upstream=request({
    host:'127.0.0.1',port:hubPort,path:'/agent',method:'GET',
    headers:{host:'127.0.0.1:'+hubPort,authorization,
      connection:'Upgrade',upgrade:'websocket',
      'sec-websocket-version':'13','sec-websocket-key':key},
  });
  timer=setTimeout(()=>fail(503),10_000);
  timer.unref();
  upstream.once('error',()=>{if(!closed)fail(503);});
  upstream.once('response',response=>{
    response.resume();
    fail(response.statusCode===401?401:response.statusCode===403?403:503);
  });
  upstream.once('upgrade',(response,connected,received)=>{
    peer=connected;
    if(closed||socket.destroyed){connected.destroy();return;}
    // A syntactically valid but unrelated accept is not proof of this handshake.
    if(response.statusCode!==101||
       !containsToken(response.headers.connection,'upgrade')||
       response.headers.upgrade?.toLowerCase()!=='websocket'||
       response.headers['sec-websocket-accept']!==accept){
      fail(503);
      return;
    }
    upgraded=true;
    clearTimeout(timer);
    connected.once('error',()=>cleanup(true));
    connected.once('close',()=>cleanup(true));
    connected.once('end',()=>cleanup(true));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    if(received.length)socket.write(received);
    if(head.length)connected.write(head);
    // pipe() provides normal stream backpressure; also cap pending output
    // so a slow/half-closed peer cannot hold an unbounded socket backlog.
    socket.on('data',()=>{
      if(!closed&&connected.writableLength>MAX_PENDING_BYTES)cleanup(true);
    });
    connected.on('data',()=>{
      if(!closed&&socket.writableLength>MAX_PENDING_BYTES)cleanup(true);
    });
    connected.pipe(socket);
    socket.pipe(connected);
  });
  upstream.end();
}