import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {NetworkInterfaceInfo} from 'node:os';
import {
  isTailscalePrivateIPv4,resolvePinnedTailscaleInterface,
  verifyOwnerRpcLoopbackDestination,makeOwnerQuotaOverlayRequestHandler,
  startProposedOwnerQuotaTailscaleProxy,
} from '../src/product/owner-quota-tailscale-proxy-proposal.js';

const RPC_PATH='/internal/owner-quota/v1/reserve';
const trustedIp='100.116.23.60';
const mockInterfaces:Record<string,NetworkInterfaceInfo[]>={
  Tailscale:[{
    address:trustedIp,netmask:'255.192.0.0',family:'IPv4',
    mac:'00:00:00:00:00:00',internal:false,cidr:trustedIp+'/10',
  }],
  Ethernet:[{
    address:'192.168.0.15',netmask:'255.255.255.0',family:'IPv4',
    mac:'01:00:00:00:00:00',internal:false,cidr:'192.168.0.15/24',
  }],
};
async function listen(server:Server){
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      server.off('error',reject);resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}
async function close(server:Server){
  server.closeAllConnections();
  await new Promise<void>((resolve,reject)=>
    server.close(err=>err?reject(err):resolve()));
}
async function fixture(fetchOverride?:typeof fetch){
  const observed:Array<{body:string,host:string|undefined,cookie:string|undefined,
    auth:string|undefined,forwarded:string|undefined}>=[];
  const owner=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];
    for await(const ch of req)chunks.push(ch as Buffer);
    observed.push({
      body:Buffer.concat(chunks).toString('utf8'),
      host:req.headers.host,cookie:req.headers.cookie,
      auth:req.headers.authorization,forwarded:req.headers['x-forwarded-for'] as string|undefined,
    });
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({decision:{status:'reserved',
      authorizesToolExecution:false}}));
  });
  const ownerPort=await listen(owner);
  const origin='http://127.0.0.1:'+ownerPort+RPC_PATH;
  const handler=makeOwnerQuotaOverlayRequestHandler({
    trustedOwnerRpcOrigin:origin,
    expectedSocketLocalIPv4:'127.0.0.1',
    ...(fetchOverride?{fetchImpl:fetchOverride}:{}),
  });
  const proxy=createServer((req,res)=>{void handler(req,res)});
  proxy.on('upgrade',(_req,socket)=>socket.destroy());
  const port=await listen(proxy);
  const url='http://127.0.0.1:'+port+RPC_PATH;
  return {url,observed,owner,proxy,async stop(){await close(proxy);await close(owner)}};
}
test('only 100.64.0.0/10 Tailscale IPv4 accepted, ordinary LAN and public denied',()=>{
  for(const ip of ['100.64.0.1','100.88.128.85','100.116.23.60','100.127.255.254']){
    assert.equal(isTailscalePrivateIPv4(ip),true,ip);
  }
  for(const ip of ['100.63.255.255','100.128.0.1','8.8.8.8','10.0.0.1',
    '127.0.0.1','192.168.1.2','::1','100.127.256.2']){
    assert.equal(isTailscalePrivateIPv4(ip),false,ip);
  }
});
test('strict existing Tailscale adapter required, not generic 100.x Ethernet',()=>{
  assert.deepEqual(resolvePinnedTailscaleInterface(trustedIp,mockInterfaces),
    {interfaceName:'Tailscale',address:trustedIp});
  assert.throws(()=>resolvePinnedTailscaleInterface('100.64.1.1',mockInterfaces));
  assert.throws(()=>resolvePinnedTailscaleInterface('192.168.0.15',mockInterfaces));
  assert.throws(()=>resolvePinnedTailscaleInterface('0.0.0.0',mockInterfaces));
  assert.throws(()=>resolvePinnedTailscaleInterface(trustedIp,{
    Ethernet:mockInterfaces.Tailscale!,
  }));
  assert.throws(()=>resolvePinnedTailscaleInterface(trustedIp,{
    Tailscale:[...mockInterfaces.Tailscale!,...mockInterfaces.Tailscale!],
  }));
  assert.throws(()=>resolvePinnedTailscaleInterface(trustedIp,{
    Tailscale:[{...mockInterfaces.Tailscale![0]!,internal:true}],
  }));
});
test('upstream must be exact loopback owner quota endpoint, no SSRF or public hub',()=>{
  const canonical='http://127.0.0.1:43123'+RPC_PATH;
  assert.equal(verifyOwnerRpcLoopbackDestination(canonical),canonical);
  for(const value of [
    'https://127.0.0.1:43123'+RPC_PATH,
    'http://localhost:43123'+RPC_PATH,
    'http://0.0.0.0:43123'+RPC_PATH,
    'http://100.116.23.60:43123'+RPC_PATH,
    'http://127.0.0.1:43123/agent',
    'http://127.0.0.1:43123'+RPC_PATH+'?url=http://evil',
    'http://admin:secret@127.0.0.1:43123'+RPC_PATH,
    'http://127.0.0.1'+RPC_PATH,
  ])assert.throws(()=>verifyOwnerRpcLoopbackDestination(value),value);
});
test('signed JSON envelope travels unchanged; proxy never forwards user headers',async()=>{
  const f=await fixture();try{
    const body=JSON.stringify({version:1,nonce:'test-nonce',signatureBase64url:'fake'});
    const reply=await fetch(f.url,{
      method:'POST',headers:{
        'content-type':'application/json',
        authorization:'Bearer malicious-header',
        cookie:'session=attacker',
        'x-forwarded-for':'10.0.0.77',
        'x-tunnel-id':'spoof',
      },
      body,
    });
    assert.equal(reply.status,200);
    const data=await reply.json() as {decision:{status:string;authorizesToolExecution:boolean}};
    assert.equal(data.decision.status,'reserved');
    assert.equal(data.decision.authorizesToolExecution,false);
    assert.deepEqual(f.observed.map(o=>o.body),[body]);
    assert.equal(f.observed[0]!.auth,undefined);
    assert.equal(f.observed[0]!.cookie,undefined);
    assert.equal(f.observed[0]!.forwarded,undefined);
    assert.match(f.observed[0]!.host??'',/^127\.0\.0\.1:/);
    assert.equal(reply.headers.get('cache-control'),'no-store');
  }finally{await f.stop()}
});
test('GET, /agent and arbitrary URL are never forwarded to owner RPC',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.url)).status,404);
    assert.equal((await fetch(new URL('/agent',f.url),{
      method:'POST',headers:{'content-type':'application/json'},body:'{}',
    })).status,404);
    assert.equal((await fetch(new URL('/internal/owner-quota/v1/secret',f.url),{
      method:'POST',headers:{'content-type':'application/json'},body:'{}',
    })).status,404);
    assert.equal(f.observed.length,0);
  }finally{await f.stop()}
});
test('wrong content-type and HTTP oversized body never hit internal RPC',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.url,{
      method:'POST',headers:{'content-type':'text/plain'},body:'{}',
    })).status,415);
    const result=await fetch(f.url,{
      method:'POST',headers:{'content-type':'application/json'},
      body:'a'.repeat(17000),
    });
    assert.equal(result.status,413);
    assert.equal(f.observed.length,0);
  }finally{await f.stop()}
});
test('missing local destination or timeout always fails closed with 503',async()=>{
  const f=await fixture((async()=>{throw new Error('upstream offline')}) as typeof fetch);
  try{
    const result=await fetch(f.url,{
      method:'POST',headers:{'content-type':'application/json'},body:'{}',
    });
    assert.equal(result.status,503);
    assert.deepEqual(await result.json(),{error:'owner_quota_rpc_unavailable'});
  }finally{await f.stop()}
});
test('missing or invalid Tailscale interface prevents actual network listener start',async()=>{
  await assert.rejects(startProposedOwnerQuotaTailscaleProxy({
    expectedTailscaleIPv4:'192.168.1.1',
    trustedOwnerRpcOrigin:'http://127.0.0.1:43123'+RPC_PATH,
  }),/Tailscale private/);
});

test('real owner RPC behind overlay handler verifies signature and reserves once',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const {readFileSync}=await import('node:fs');
  const path=await import('node:path');
  const {generateKeyPairSync,createHash}=await import('node:crypto');
  const {startProposedOwnerQuotaLoopbackRpc,signDevOwnerQuotaRpcEnvelope}
    =await import('../src/product/owner-quota-loopback-rpc-proposal.js');
  const {ProposedTrustedOwnerQuotaAuthority}
    =await import('../src/product/trusted-owner-quota-authority-proposal.js');
  const db=new DatabaseSync(':memory:');
  for(const file of [
    'test/fixtures/scale-v2-owner-shared-quota-dev.sql',
    'test/fixtures/scale-v2-all-ingress-transport-staging.sql',
    'test/fixtures/scale-v2-owner-quota-rpc-dev.sql',
  ])db.exec(readFileSync(path.join(process.cwd(),file),'utf8'));
  const account='overlay-owner-account-001',dev='overlay-signed-device-001';
  const bearer='overlay-first-party-token-001';
  db.prepare('INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)')
    .run(account,'custom',100,1,2);
  db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
    .run(dev,account,1,'safe');
  const kp=generateKeyPairSync('ed25519');
  const pub=kp.publicKey.export({format:'pem',type:'spki'}).toString();
  const priv=kp.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  db.prepare('INSERT INTO proposed_owner_rpc_device_keys VALUES(?,?,1)')
    .run(dev,pub);
  const authority=new ProposedTrustedOwnerQuotaAuthority(
    db,async token=>token===bearer?{accountId:account,sessionGeneration:2}:null);
  const rpc=await startProposedOwnerQuotaLoopbackRpc({
    db,authority,
    trustedToolCatalog:new Map([['catalog-read-001',{
      operationClass:'read',
      toolFingerprint:createHash('sha256').update('owner:catalog-read').digest('hex'),
    }]]),
  });
  const handler=makeOwnerQuotaOverlayRequestHandler({
    trustedOwnerRpcOrigin:rpc.origin,
    expectedSocketLocalIPv4:'127.0.0.1',
  });
  const proxy=createServer((req,res)=>{void handler(req,res)});
  const port=await listen(proxy);
  const url='http://127.0.0.1:'+port+RPC_PATH;
  try{
    const signed=signDevOwnerQuotaRpcEnvelope({
      envelope:{
        version:1,deviceId:dev,nonce:'overlay-unique-nonce-001',
        issuedAtMs:Date.now(),
        body:{
          bearerToken:bearer,invocationId:'overlay-tool-call-001',
          toolId:'catalog-read-001',
        },
      },
      devicePrivateKeyPem:priv,
    });
    const send=async (body:unknown)=> {
      const r=await fetch(url,{
        method:'POST',
        headers:{'content-type':'application/json',
          'x-forwarded-user':'fake-elevated-admin'},
        body:JSON.stringify(body),
      });
      return {status:r.status,json:await r.json() as Record<string,unknown>};
    };
    const success=await send(signed);
    assert.equal(success.status,200);
    assert.equal((success.json.decision as Record<string,unknown>).status,'reserved');
    assert.equal((success.json.decision as Record<string,unknown>).authorizesToolExecution,false);
    const replay=await send(signed);
    assert.equal(replay.status,409);
    const spoofed=await send({...signed,body:{...signed.body,toolId:'unknown-writable'}});
    assert.equal(spoofed.status,401);
    const used=db.prepare('SELECT used FROM proposed_owner_quota_daily').get() as {used:number};
    assert.equal(used.used,1);
  }finally{await close(proxy);await rpc.close();db.close()}
});

test('loopback-only mock cannot mint a valid private overlay IP by request Host',async()=>{
  const f=await fixture();try{
    const r=await fetch(f.url,{
      method:'POST',headers:{'content-type':'application/json',
        'x-forwarded-for':trustedIp,'x-device-id':'faker-device-01'},
      body:'{}',
    });
    assert.equal(r.status,200); // mock only, actual Ed25519 owner must reject unsigned
    assert.equal(f.observed.length,1);
  }finally{await f.stop()}
});
