import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {WebSocketServer} from 'ws';
import {
  ProposedOutboundQuotaWsClient,type OutboundQuotaFrame,
} from '../src/product/owner-quota-outbound-ws-proposal.js';
import type {OwnerPublicWssTrustProfile}
  from '../src/product/owner-public-wss-trust-proposal.js';

const path='/internal/owner-quota/v1/outbound';
const pinned:OwnerPublicWssTrustProfile={
  endpoint:'wss://edge.example.com'+path,
  expectedHostname:'edge.example.com',
  caMode:'system',
  trustedSpkiSha256:['a'.repeat(64)],
};

test('public WSS client refuses caller-directed URLs and mixed trust modes',()=>{
  assert.throws(()=>new ProposedOutboundQuotaWsClient(
    'wss://edge.example.com'+path),/STAGING|loopback|Invalid/);
  assert.throws(()=>new ProposedOutboundQuotaWsClient(
    {...pinned,endpoint:'wss://attacker.example.com'+path}
  ),/Expected exact/);
  assert.throws(()=>new ProposedOutboundQuotaWsClient(
    {...pinned,trustedSpkiSha256:[]}
  ),/one or two/);
  assert.throws(()=>new ProposedOutboundQuotaWsClient(
    pinned,{trustedCaPem:'BEGIN CERTIFICATE',expectedLeafSha256:'0'.repeat(64)}
  ),/Conflicting owner WSS trust modes/);
});

test('legacy staging outbound client rejects oversized owner WSS messages',
  {timeout:10000},async()=>{
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const wss=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!==path){socket.destroy();return}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });
  wss.on('connection',socket=>{
    socket.once('message',()=>socket.send('x'.repeat(17*1024)));
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      server.off('error',reject);resolve();
    });
  });
  const port=(server.address() as AddressInfo).port;
  const client=new ProposedOutboundQuotaWsClient(
    'ws://127.0.0.1:'+port+path,
  );
  const frame={
    version:1,kind:'reserve',
    requestId:'oversize-owner-req-001',
    // This test-only frame never reaches an owner RPC. We only exercise the
    // transport's receive cap; no OS command or real customer credential.
    envelope:{} as OutboundQuotaFrame['envelope'],
  } satisfies OutboundQuotaFrame;
  try{
    await assert.rejects(client.reserve(frame),
      /WS connection error|WS disconnected|Invalid owner WS response/);
  }finally{
    client.close();
    for(const socket of wss.clients)socket.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
