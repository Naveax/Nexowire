/**
 * DEV ONLY: execute on a SECOND physical PC after operator explicitly
 * enrolled its short-lived synthetic Ed25519 public key into owner fixture.
 * No production accounts, private keys, native tools or billing supported.
 */
'use strict';
const {createHash,createPrivateKey,sign,X509Certificate,randomBytes}=
  require('node:crypto');
const {readFileSync}=require('node:fs');
const tls=require('node:tls');
const path=require('node:path');
const vars=process.env;
const raw=vars.NEXOWIRE_DEV_PUBLIC_WSS_URL??'';
const bearer=vars.NEXOWIRE_DEV_PUBLIC_WSS_BEARER??'';
const deviceId=vars.NEXOWIRE_DEV_PUBLIC_WSS_DEVICE_ID??'';
const toolId=vars.NEXOWIRE_DEV_PUBLIC_WSS_TOOL_ID??'';
const keyFile=vars.NEXOWIRE_DEV_PUBLIC_WSS_PRIVATE_KEY_PATH??'';
const expectedSpki=vars.NEXOWIRE_DEV_PUBLIC_WSS_EDGE_SPKI??'';
let endpoint;
try{endpoint=new URL(raw)}catch{throw new Error('Missing public DEV WSS URL')}
if(endpoint.protocol!=='wss:'||
  endpoint.pathname!=='/internal/owner-quota/v1/outbound'||
  endpoint.port||endpoint.search||endpoint.hash||
  endpoint.username||endpoint.password||
  !/^[a-z0-9-]+[.]trycloudflare[.]com$/i.test(endpoint.hostname)){
  throw new Error('DEV Quick Tunnel WSS target refused');
}
if(!/^[A-Za-z0-9_:.@-]{8,128}$/.test(deviceId)||
  !/^[A-Za-z0-9_:.@-]{8,128}$/.test(toolId)||
  bearer.length<16||bearer.length>8192||
  !path.isAbsolute(keyFile)||
  !/^[a-f0-9]{64}$/.test(expectedSpki)){
  throw new Error('Missing or invalid independently pinned DEV connection configuration');
}
if(typeof WebSocket!=='function')throw new Error('Native Node WebSocket unavailable');
function authenticateEdge(){
  return new Promise((resolve,reject)=>{
    const socket=tls.connect({
      host:endpoint.hostname,servername:endpoint.hostname,port:443,
      rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',
    },()=>{
      try{
        if(!socket.authorized||socket.getProtocol()!=='TLSv1.3'){
          throw new Error('TLS 1.3 or public CA failed');
        }
        const cert=new X509Certificate(socket.getPeerCertificate().raw);
        const actual=createHash('sha256').update(cert.publicKey.export({
          type:'spki',format:'der',
        })).digest('hex');
        if(actual!==expectedSpki)throw new Error('Pinned Cloudflare edge key changed');
        socket.end();resolve();
      }catch(e){socket.destroy();reject(e)}
    });
    socket.once('error',reject);
    socket.setTimeout(12000,()=>socket.destroy(new Error('Edge TLS timeout')));
  });
}
async function run(){
  await authenticateEdge();
  const privateKey=createPrivateKey(readFileSync(keyFile,'utf8'));
  if(privateKey.asymmetricKeyType!=='ed25519'){
    throw new Error('Not a device Ed25519 key');
  }
  const nonce='public-dev-nonce-'+randomBytes(12).toString('hex');
  const invocationId='public-dev-inv-'+randomBytes(12).toString('hex');
  const one='public-dev-req-'+randomBytes(9).toString('hex');
  const replay='public-dev-replay-'+randomBytes(9).toString('hex');
  const body={bearerToken:bearer,invocationId,toolId};
  const unsigned={version:1,deviceId,nonce,issuedAtMs:Date.now(),body};
  const bodyHash=createHash('sha256').update(JSON.stringify([
    body.bearerToken,body.invocationId,body.toolId,
  ])).digest('hex');
  const canonical=Buffer.from(JSON.stringify([
    'nexowire-owner-quota-rpc-v1','POST',
    '/internal/owner-quota/v1/reserve',
    1,deviceId,nonce,unsigned.issuedAtMs,bodyHash,
  ]));
  const envelope={...unsigned,signatureBase64url:
    sign(null,canonical,privateKey).toString('base64url')};
  const socket=new WebSocket(raw);
  await new Promise((resolve,reject)=>{
    let stage=0,settled=false;
    const finish=err=>{
      if(settled)return;settled=true;clearTimeout(timeout);
      socket.close();
      if(err)reject(err);else resolve();
    };
    const timeout=setTimeout(()=>finish(new Error('Signed owner WSS test timed out')),
      25000);
    socket.addEventListener('open',()=>{
      socket.send(JSON.stringify({
        version:1,kind:'reserve',requestId:one,envelope,
      }));
    });
    socket.addEventListener('message',event=>{
      try{
        const response=JSON.parse(String(event.data));
        if(stage===0){
          if(response.requestId!==one||response.httpStatus!==200||
            response.data?.decision?.status!=='reserved'||
            response.data.decision.authorizesToolExecution!==false){
            throw new Error('Signed RPC failed to reserve read-only tool quota');
          }
          stage=1;
          socket.send(JSON.stringify({
            version:1,kind:'reserve',requestId:replay,envelope,
          }));
        }else if(stage===1){
          if(response.requestId!==replay||
            response.httpStatus!==409){
            throw new Error('Previously consumed device nonce not rejected as 409');
          }
          stage=2;
          process.stdout.write(
            'TLS13_CA_AND_SEPARATE_EDGE_PIN_PREFLIGHT=PASS\n'+
            'DEVICE_HELD_ED25519_QUOTA_RESERVATION=PASS\n'+
            'NONCE_REPLAY_DENIED_409=PASS\n'+
            'NO_NATIVE_TOOL_EXECUTION=TRUE\n',
          );
          finish();
        }
      }catch(e){finish(e)}
    });
    socket.addEventListener('error',()=>finish(new Error('Public WSS failed')));
    socket.addEventListener('close',()=>{
      if(stage!==2)finish(new Error('WSS closed before successful checks'));
    });
  });
}
run().catch(e=>{process.stderr.write(String(e.stack??e)+'\n');process.exitCode=1});
