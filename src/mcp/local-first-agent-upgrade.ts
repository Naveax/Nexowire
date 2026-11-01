import {request,type IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';

/** Fixed loopback /agent bridge. The real Hub authenticates before we return
 * 101. Never substitutes a shared relay token, arbitrary host or device ID. */
export function bridgeLocalAgentUpgrade(req:IncomingMessage,socket:Duplex,head:Buffer,
  hubPort:number,onClose:()=>void){
  let peer:Duplex|undefined;
  let closed=false;
  socket.once('error',()=>socket.destroy());
  const finish=()=>{if(closed)return;closed=true;clearTimeout(timer);upstream.destroy();peer?.destroy();onClose();};
  const fail=(status=401)=>{
    if(!socket.destroyed)socket.end(`HTTP/1.1 ${status} Connection Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,()=>socket.destroy());
    finish();
  };
  const key=req.headers['sec-websocket-key'];
  const authorization=req.headers.authorization;
  if(req.method!=='GET'||req.url!=='/agent'||
      !authorization||!/^Bearer nwx_dev_[A-Za-z0-9_-]{1,490}$/.test(authorization)||
      typeof key!=='string'||!/^[A-Za-z0-9+/]{22}==$/.test(key)||
      req.headers['sec-websocket-version']!=='13'){
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',()=>socket.destroy());
    onClose();return;
  }
  const upstream=request({host:'127.0.0.1',port:hubPort,path:'/agent',method:'GET',
    headers:{host:`127.0.0.1:${hubPort}`,authorization,connection:'Upgrade',upgrade:'websocket',
      'sec-websocket-version':'13','sec-websocket-key':key}});
  const timer=setTimeout(()=>fail(503),10000);
  socket.once('close',finish);
  upstream.once('error',()=>fail(503));
  upstream.once('response',response=>{response.destroy();fail(response.statusCode===401?401:503);});
  upstream.once('upgrade',(response,connected,received)=>{
    peer=connected;
    if(closed||socket.destroyed){connected.destroy();return;}
    const accept=response.headers['sec-websocket-accept'];
    if(response.statusCode!==101||typeof accept!=='string'||!/^[A-Za-z0-9+/]{27}=$/.test(accept)){fail(503);return;}
    clearTimeout(timer);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    connected.once('error',()=>socket.destroy());connected.once('close',()=>socket.destroy());
    if(received.length)socket.write(received);
    if(head.length)connected.write(head);
    connected.pipe(socket);socket.pipe(connected);
  });
  upstream.end();
}
