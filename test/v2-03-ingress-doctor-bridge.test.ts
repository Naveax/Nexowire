import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import WebSocket from 'ws';
import {loadConfig} from '../src/config.js';
import {inspectCloudflareConnection} from '../src/mcp/cloudflare-connection-doctor.js';
import {createLocalFirstIngressServer} from '../src/mcp/local-first-ingress.js';

const resource='https://mcp.example.test/mcp';
const metadataUrl='https://mcp.example.test/.well-known/oauth-protected-resource/mcp';
function config(){return loadConfig({
  NEXOWIRE_MCP_RESOURCE_URL:resource,
  NEXOWIRE_CONTROL_PLANE_URL:'https://control.example.test',
  NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'disposable-not-a-real-token',
});}
function profile(){return {
  version:1,hostname:'mcp.example.test',tunnelId:randomUUID(),
  binary:process.execPath,binarySha256:'a'.repeat(64),
  credentialsFile:process.execPath,listenPort:43111,
};}
function fetchFixture(metadata:unknown,authorizationStatus=401,challenge=true):typeof fetch{
  return async (url,init)=>{
    assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).has('authorization'),false);
    if(String(url)===metadataUrl){
      return Response.json(metadata);
    }
    assert.equal(String(url),resource);
    return new Response('{}',{status:authorizationStatus,headers:challenge?
      {'www-authenticate':'Bearer resource_metadata="'+metadataUrl+'", scope="mcp"'}:{}});
  };
}
test('V2-03 doctor requires exact resource/issuer and genuine bearer challenge, never claims tool readiness',async()=>{
  const metadata={resource,authorization_servers:['https://control.example.test']};
  const valid=await inspectCloudflareConnection(profile(),config(),fetchFixture(metadata));
  assert.equal(valid.stage,'PUBLIC_OAUTH_BOUNDARY_OK');
  assert.equal(valid.readiness,'PUBLIC_OAUTH_BOUNDARY_OK');
  assert.equal(valid.publicBoundaryVerified,true);
  assert.equal(valid.authenticatedToolVerified,false);
  assert.equal(valid.agentAuthenticated,false);
  const forged=await inspectCloudflareConnection(profile(),config(),fetchFixture(metadata,401,false));
  assert.equal(forged.stage,'PUBLIC_AUTH_BOUNDARY_FAILED');
  assert.equal(forged.publicBoundaryVerified,false);
  const wrong=await inspectCloudflareConnection(profile(),config(),
    fetchFixture({resource,authorization_servers:['https://attacker.example.test']}));
  assert.equal(wrong.stage,'PUBLIC_OAUTH_RESOURCE_MISMATCH');
});
test('V2-03 doctor distinguishes metadata 401/403/5xx, auth 403/5xx and transport timeout',async()=>{
  for(const [status,expected] of [[401,'PUBLIC_METADATA_HTTP_401'],[403,'PUBLIC_METADATA_HTTP_403'],
    [503,'PUBLIC_METADATA_HTTP_5XX']] as const){
    const result=await inspectCloudflareConnection(profile(),config(),async()=>new Response('',{status}));
    assert.equal(result.stage,expected);
  }
  for(const [status,expected] of [[403,'PUBLIC_AUTH_HTTP_403'],[502,'PUBLIC_AUTH_HTTP_5XX']] as const){
    const result=await inspectCloudflareConnection(profile(),config(),
      fetchFixture({resource,authorization_servers:['https://control.example.test']},status));
    assert.equal(result.stage,expected);
  }
  const result=await inspectCloudflareConnection(profile(),config(),async()=>{
    const error=new Error('disposable deadline');error.name='TimeoutError';throw error;
  });
  assert.equal(result.stage,'PUBLIC_METADATA_TIMEOUT');
});
test('V2-03 ingress rejects query, spoofed Host/Origin, oversized upstream output, and proxy CONNECT',async t=>{
  const hub=createServer((req,res)=>{
    if(req.url==='/mcp'){
      res.setHeader('mcp-session-id','disposable-session');
      res.end('x'.repeat(10000));
      return;
    }
    res.statusCode=404;res.end();
  });
  await new Promise<void>(r=>hub.listen(0,'127.0.0.1',r));
  const hp=(hub.address() as AddressInfo).port;
  const origin=createLocalFirstIngressServer({hubPort:hp,listenPort:43111,
    publicHostname:'mcp.example.test',maxResponseBytes:4096});
  await new Promise<void>(r=>origin.listen(0,'127.0.0.1',r));
  const port=(origin.address() as AddressInfo).port;
  t.after(async()=>{
    origin.closeAllConnections();
    await new Promise<void>(r=>origin.close(()=>r()));
    await new Promise<void>(r=>hub.close(()=>r()));
  });
  async function send(path:string,host:string,originHeader?:string){
    const res=await fetch('http://127.0.0.1:'+port+path,{
      method:'POST',headers:{host,authorization:'Bearer disposable01234567890',
        ...(originHeader?{origin:originHeader}:{})},body:'{}'});
    await res.arrayBuffer().catch(()=>{});
    return res.status;
  }
  assert.equal(await send('/mcp?debug=true','mcp.example.test'),404);
  assert.equal(await send('/mcp','spoof.example.test'),403);
  assert.equal(await send('/mcp','mcp.example.test','https://attacker.example.test'),403);
  await assert.rejects(send('/mcp','mcp.example.test'));
  const result=await new Promise<boolean>(resolve=>{
    const req=request({host:'127.0.0.1',port,method:'CONNECT',path:'/mcp'});
    req.once('connect',()=>resolve(false));
    req.once('error',()=>resolve(true));
    req.once('close',()=>resolve(true));
    req.end();
  });
  assert.equal(result,true);
});
test('V2-03 bridge rejects upstream HTTP 101 with forged WebSocket accept',async t=>{
  const hub=createServer();
  const peers=new Set<import('node:net').Socket>();
  hub.on('upgrade',(_req,socket)=>{
    peers.add(socket);socket.once('close',()=>peers.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'+
      'Connection: Upgrade\r\nSec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\n\r\n');
  });
  await new Promise<void>(r=>hub.listen(0,'127.0.0.1',r));
  const origin=createLocalFirstIngressServer({hubPort:(hub.address() as AddressInfo).port,
    listenPort:43111,publicHostname:'mcp.example.test',allowAgentWebSocket:true});
  await new Promise<void>(r=>origin.listen(0,'127.0.0.1',r));
  t.after(async()=>{
    for(const socket of peers)socket.destroy();
    origin.closeAllConnections();
    await new Promise<void>(r=>origin.close(()=>r()));
    await new Promise<void>(r=>hub.close(()=>r()));
  });
  const socket=new WebSocket('ws://127.0.0.1:'+(origin.address() as AddressInfo).port+'/agent',{
    headers:{authorization:'Bearer nwx_dev_disposable'}});
  socket.on('error',()=>{});
  let opened=false;socket.once('open',()=>{opened=true;});
  const status=await new Promise<number>((resolve,reject)=>{
    socket.once('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode??0);socket.terminate();});
    socket.once('error',reject);
  });
  assert.equal(status,503);
  assert.equal(opened,false);
});
