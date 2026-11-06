import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createSign,randomBytes,randomUUID} from 'node:crypto';
import {createServer as createHttpsServer} from 'node:https';
import {createServer as createHttpServer,type Server as HttpServer} from 'node:http';
import {once} from 'node:events';
import WebSocket from 'ws';
import {AgentBroker} from '../src/core/agent-broker.js';
import {attachAgentWebSocketServer} from '../src/hub/agent-websocket.js';
import {createControlPlaneAgentCredentialVerifier} from '../src/hub/control-plane-agent-auth.js';
import {bindRemoteAgentMutationReauthorization,hasTrustedRemoteAgentGrant} from '../src/mcp/http.js';
import {AGENT_PROTOCOL_VERSION} from '../src/protocol/agent.js';

/** A disposable in-memory TLS CA and leaf. No openssl executable, private
 * fixture PEM, real DNS, trusted CA store or environment mutation required. */
function localhostTlsIdentity(){
  const der=(tag:number,...chunks:Buffer[]):Buffer=>{
    const bytes=Buffer.concat(chunks),size=bytes.length;
    const length=size<128?Buffer.from([size]):size<256?
      Buffer.from([0x81,size]):Buffer.from([0x82,(size>>8)&255,size&255]);
    return Buffer.concat([Buffer.from([tag]),length,bytes]);
  };
  const seq=(...parts:Buffer[])=>der(0x30,...parts);
  const oid=(hex:string)=>der(0x06,Buffer.from(hex,'hex'));
  const pair=generateKeyPairSync('rsa',{modulusLength:2048});
  const algorithm=seq(oid('2a864886f70d01010b'),der(0x05));
  const name=seq(der(0x31,seq(oid('550403'),der(0x0c,Buffer.from('localhost')))));
  const utc=(date:Date)=>{
    const part=(n:number)=>String(n).padStart(2,'0');
    return der(0x17,Buffer.from(part(date.getUTCFullYear()%100)+
      part(date.getUTCMonth()+1)+part(date.getUTCDate())+
      part(date.getUTCHours())+part(date.getUTCMinutes())+
      part(date.getUTCSeconds())+'Z'));
  };
  const validity=seq(utc(new Date(Date.now()-86400000)),
    utc(new Date(Date.now()+7*86400000)));
  const altNames=seq(oid('551d11'),der(0x04,seq(
    der(0x82,Buffer.from('localhost')),
    der(0x87,Buffer.from([127,0,0,1])))));
  const basic=seq(oid('551d13'),der(0x01,Buffer.from([0xff])),
    der(0x04,seq(der(0x01,Buffer.from([0xff])))));
  const serial=randomBytes(16);serial[0]=serial[0]!&0x7f;
  const toSign=seq(der(0xa0,der(0x02,Buffer.from([2]))),der(0x02,serial),
    algorithm,name,validity,name,pair.publicKey.export({type:'spki',format:'der'}),
    der(0xa3,seq(altNames,basic)));
  const signature=createSign('sha256').update(toSign).end().sign(pair.privateKey);
  const certificate=seq(toSign,algorithm,der(0x03,Buffer.from([0]),signature));
  const cert='-----BEGIN CERTIFICATE-----\n'+
    (certificate.toString('base64').match(/.{1,64}/g)??[]).join('\n')+
    '\n-----END CERTIFICATE-----\n';
  return {key:pair.privateKey.export({type:'pkcs8',format:'pem'}),cert};
}

test('CLEAN-14 P1-C: actual WSS verifies TLS certificate and device before 101, and binds Agent hello',{
  timeout:18000,
},async t=>{
  const {key,cert}=localhostTlsIdentity();
  const device='disposable-wss-device';
  const good='nwx_dev_disposable-wss-credential';
  const service='disposable-service-token-wss-123456789';
  const ownerId='owner-clean14';
  const authorizationEpoch=5;
  const leaseExpiresAtMs=Date.now()+60000;
  let valid=true,authorityChecks=0;
  const authority=createHttpServer((req,res)=>{
    if(req.method!=='POST'||req.url!=='/api/v1/internal/device/authenticate'||
       req.headers.authorization!=='Bearer '+service){
      res.writeHead(403).end('{}');return;
    }
    const chunks:Buffer[]=[];
    req.on('data',(chunk:Buffer)=>chunks.push(chunk));
    req.on('end',()=>{
      authorityChecks++;
      let candidate='';
      try{candidate=(JSON.parse(Buffer.concat(chunks).toString('utf8')) as {credential:string}).credential;}
      catch{}
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify(valid&&candidate===good?
        {authenticated:true,device:{
          deviceId:device,ownerAccountId:ownerId,
          authorizationEpoch,leaseExpiresAtMs,
        }}:{authenticated:false}));
    });
  });
  await new Promise<void>(resolve=>authority.listen(0,'127.0.0.1',resolve));
  const controlPort=(authority.address() as {port:number}).port;
  const verifier=createControlPlaneAgentCredentialVerifier({
    controlPlaneUrl:'http://127.0.0.1:'+controlPort,
    serviceToken:service,timeoutMs:1500,
  });
  const hub=createHttpsServer({key,cert});
  const broker=new AgentBroker({reconnectGraceMs:100,requireMutationReauthorization:true});
  // The real remote endpoint always requires a per-socket owner/device grant.
  // A startup assertion failure must also close this disposable authority,
  // otherwise its HTTP handle leaves the CI test runner waiting indefinitely.
  let wss:ReturnType<typeof attachAgentWebSocketServer>;
  try {
    wss=attachAgentWebSocketServer(hub as unknown as HttpServer,broker,[],{
      remoteOnly:true,remoteCredentialVerifier:verifier,
      remoteMutationAuthorizationFactory:(grant,authorizationHeader)=>
        hasTrustedRemoteAgentGrant(grant)
          ? bindRemoteAgentMutationReauthorization({
              grant,authorizationHeader,verify:verifier,timeoutMs:1500,
            })
          : undefined,
      authorizationCheckMs:60000,authorizationTimeoutMs:1500,heartbeatMs:60000,
    });
  } catch (error) {
    authority.closeAllConnections();
    await new Promise<void>(resolve=>authority.close(()=>resolve()));
    throw error;
  }
  await new Promise<void>(resolve=>hub.listen(0,'127.0.0.1',resolve));
  const hubPort=(hub.address() as {port:number}).port;
  const url='wss://127.0.0.1:'+hubPort+'/agent';
  const sockets:WebSocket[]=[];
  const dial=(credential:string,opts:Record<string,unknown>={})=>{
    const socket=new WebSocket(url,{
      headers:{authorization:'Bearer '+credential},ca:cert,
      handshakeTimeout:4000,...opts,
    });
    socket.on('error',()=>{});
    sockets.push(socket);
    return socket;
  };
  t.after(async()=>{
    for(const ws of sockets)ws.terminate();
    for(const ws of wss.clients)ws.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
    hub.closeAllConnections();
    await new Promise<void>(resolve=>hub.close(()=>resolve()));
    authority.closeAllConnections();
    await new Promise<void>(resolve=>authority.close(()=>resolve()));
  });
  const failedTls=dial(good,{ca:undefined});
  const tlsFailure=await new Promise<string|undefined>(resolve=>{
    failedTls.once('error',e=>resolve((e as NodeJS.ErrnoException).code));
    failedTls.once('open',()=>resolve('TLS_UNEXPECTED_SUCCESS'));
  });
  assert.equal(tlsFailure,'DEPTH_ZERO_SELF_SIGNED_CERT',
    'system CA must not trust disposable cert implicitly');

  const wrongHostname=dial(good,{servername:'other.example.test'});
  const hostError=await new Promise<string|undefined>(resolve=>{
    wrongHostname.once('error',e=>resolve((e as NodeJS.ErrnoException).code));
    wrongHostname.once('open',()=>resolve('TLS_UNEXPECTED_SUCCESS'));
  });
  assert.equal(hostError,'ERR_TLS_CERT_ALTNAME_INVALID');

  const unauthorized=dial('nwx_dev_shared-legacy-credential');
  const rejectedStatus=await new Promise<number>((resolve,reject)=>{
    unauthorized.once('unexpected-response',(_request,response)=>{
      response.resume();unauthorized.terminate();resolve(response.statusCode??0);
    });
    unauthorized.once('open',()=>reject(Error('HTTP 101 before owner/device verification')));
  });
  assert.equal(rejectedStatus,401);
  assert.equal(broker.has(device),false);

  valid=false;
  const revoked=dial(good);
  const revokedStatus=await new Promise<number>((resolve,reject)=>{
    revoked.once('unexpected-response',(_request,response)=>{
      response.resume();revoked.terminate();resolve(response.statusCode??0);
    });
    revoked.once('open',()=>reject(Error('revoked device upgraded before 101')));
  });
  assert.equal(revokedStatus,401);
  valid=true;

  const authorized=dial(good);
  await once(authorized,'open',{signal:AbortSignal.timeout(5000)});
  authorized.send(JSON.stringify({
    type:'hello',protocolVersion:AGENT_PROTOCOL_VERSION,
    instanceId:randomUUID(),
    device:{id:'foreign-device',name:'Disposable',platform:process.platform,
      arch:process.arch,agentVersion:'test',capabilities:['files.write']},
  }));
  const [closeCode]=await once(authorized,'close',{signal:AbortSignal.timeout(5000)});
  assert.equal(closeCode,1008,'bound Hub must reject mismatched Agent hello');
  assert.equal(broker.has('foreign-device'),false);
  assert.equal(broker.has(device),false);
  assert.equal(authorityChecks,3,'real HTTP authority was called for shared/revoked/valid credentials only');
});
