import {constants} from 'node:crypto';
import {createServer,type Server} from 'node:https';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {Socket} from 'node:net';
import type {TLSSocket} from 'node:tls';

export interface CoreNativeVerifierServerOptions {
  /** Explicitly provisioned PEM material; no credential generation or lookup. */
  readonly keyPem:string;
  readonly certificatePem:string;
  readonly clientCaPem:string;
  readonly handler:(request:IncomingMessage,response:ServerResponse)=>void;
  readonly maxConnections?:number;
  readonly maxActiveRequests?:number;
  readonly headerDeadlineMs?:number;
  readonly requestDeadlineMs?:number;
}

/** Unbound off-host transport component. Does not install, listen, enroll or
 * grant authority. Compose only with the independent ledger/signer handler.
 * Transport overload/timeout is an unknown outcome, never a retry instruction. */
export function createCoreNativeVerifierServer(options:CoreNativeVerifierServerOptions):Server {
  const key=options.keyPem,cert=options.certificatePem,ca=options.clientCaPem;
  const handler=options.handler,maxConnections=options.maxConnections??32;
  const maxActive=options.maxActiveRequests??16;
  const headersMs=options.headerDeadlineMs??5000,requestMs=options.requestDeadlineMs??10000;
  const bounded=(n:number,min:number,max:number)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
  if(typeof key!=='string'||!key.includes('PRIVATE KEY-----')||
    typeof cert!=='string'||!cert.includes('BEGIN CERTIFICATE')||
    typeof ca!=='string'||!ca.includes('BEGIN CERTIFICATE')||typeof handler!=='function'||
    !bounded(maxConnections,1,128)||!bounded(maxActive,1,64)||maxActive>maxConnections||
    !bounded(headersMs,100,10000)||!bounded(requestMs,100,15000))
    throw Error('CORE_NATIVE_VERIFIER_HOST_CONFIGURATION_INVALID');
  const server=createServer({key,cert,ca,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',
    requestCert:true,rejectUnauthorized:true,handshakeTimeout:headersMs,
    secureOptions:constants.SSL_OP_NO_RENEGOTIATION|constants.SSL_OP_NO_TICKET,
    ALPNProtocols:['http/1.1'],maxHeaderSize:8192},dispatch);
  server.maxConnections=maxConnections;
  // Preserve all parser-accepted fields so duplicate/late auth headers cannot
  // disappear through truncation. Bytes are bounded by maxHeaderSize above;
  // excess field count is explicitly denied below before authority dispatch.
  server.maxHeadersCount=0;
  server.maxRequestsPerSocket=1;
  server.headersTimeout=headersMs;
  server.requestTimeout=requestMs;
  server.keepAliveTimeout=1;
  const handshakes=new Map<Socket,ReturnType<typeof setTimeout>>();
  const headers=new Map<Socket,ReturnType<typeof setTimeout>>();
  let active=0;
  // Node's TLS handshake timer alone does not bound an idle TCP peer that has
  // not supplied a ClientHello. Start an independent deadline at TCP accept.
  server.on('connection',socket=>{
    if(!(socket instanceof Socket)){socket.destroy();return}
    const timer=setTimeout(()=>socket.destroy(),headersMs);timer.unref();handshakes.set(socket,timer);
    socket.once('close',()=>{clearTimeout(timer);handshakes.delete(socket)});
  });
  // Match only kernel socket endpoint tuples, never HTTP/client identity text.
  // TLS wraps the accepted socket; no private _parent field is relied upon.
  // A separate fixed deadline after handshake bounds trickled HTTP headers.
  // Node's inactivity timeout alone can be extended by sending another byte.
  server.on('secureConnection',socket=>{
    const accepted=[...handshakes.keys()].filter(raw=>raw.remotePort===socket.remotePort&&
      raw.localPort===socket.localPort&&raw.remoteAddress===socket.remoteAddress&&
      raw.localAddress===socket.localAddress);
    if(accepted.length!==1){socket.destroy();return}
    clearTimeout(handshakes.get(accepted[0]!));handshakes.delete(accepted[0]!);
    const timer=setTimeout(()=>socket.destroy(),headersMs);timer.unref();headers.set(socket,timer);
    socket.once('close',()=>{clearTimeout(timer);headers.delete(socket)});
  });
  server.on('checkContinue',(_req,res)=>deny(res,417));
  server.on('checkExpectation',(_req,res)=>deny(res,417));
  server.on('upgrade',(_req,socket)=>socket.destroy());
  server.on('connect',(_req,socket)=>socket.destroy());
  server.on('clientError',(_error,socket)=>socket.destroy());
  server.on('tlsClientError',(_error,socket)=>socket.destroy());
  function deny(res:ServerResponse,status:number){
    if(res.destroyed||res.headersSent){res.destroy();return}
    res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',
      connection:'close'});res.end('{"error":"unavailable"}');
  }
  function dispatch(req:IncomingMessage,res:ServerResponse){
    const socket=req.socket as TLSSocket;
    const headerTimer=headers.get(socket);
    if(headerTimer){clearTimeout(headerTimer);headers.delete(socket)}
    if(req.rawHeaders.length>64){deny(res,431);return}
    if(socket.authorized!==true||socket.getProtocol()!=='TLSv1.3'){
      deny(res,403);return;
    }
    if(active>=maxActive){deny(res,503);return}
    active++;
    let released=false;
    const deadline=setTimeout(()=>{deny(res,503);req.destroy()},requestMs);deadline.unref();
    const release=()=>{if(released)return;released=true;active--;clearTimeout(deadline)};
    res.once('finish',release);res.once('close',release);
    try{handler(req,res)}catch{deny(res,503)}
  }
  return server;
}
