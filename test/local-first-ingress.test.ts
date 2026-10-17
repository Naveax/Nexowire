import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createLocalFirstIngressServer,
  validateLocalFirstIngress,
  verifyLocalFirstPublicUpstream,
} from '../src/mcp/local-first-ingress.js';

const authorization='Bearer testing-token-secret-123456789012345';
async function listen(server:Server):Promise<number> {
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      server.removeListener('error',reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}
async function close(server:Server):Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
}
async function fixture(options?: {publicHostname?: string,maxConcurrent?:number,maxRequestBytes?:number}) {
  const received:Array<{path:string,method:string,host:string|undefined,authorization:string|undefined,
    spoof:string|undefined,body:string}>=[];
  const hub=createServer((req,res)=>{
    let body='';
    req.on('data',chunk=>body+=chunk.toString());
    req.on('end',()=>{
      received.push({
        path:req.url??'',method:req.method??'',host:req.headers.host,
        authorization:req.headers.authorization,spoof:req.headers['x-forwarded-for'] as string|undefined,
        body,
      });
      res.writeHead(200,{'content-type':'application/json','x-unsafe-header':'must-strip'});
      res.end(JSON.stringify({path:req.url,body}));
    });
  });
  const hubPort=await listen(hub);
  const ingress=createLocalFirstIngressServer({
    hubPort,listenPort:43111,...options,
  });
  const port=await listen(ingress);
  return {received,hub,ingress,port,hubPort,
    url:'http://127.0.0.1:'+port,
    async close(){await close(ingress);await close(hub)},
  };
}

async function rawPostWithHeaders(url:string, headers:Record<string,string>):Promise<number> {
  return new Promise<number>((resolve,reject)=>{
    const target=new URL(url);
    const request=httpRequest({
      hostname:target.hostname,port:Number(target.port),path:target.pathname,
      method:'POST',headers:{...headers,'content-length':'2'},
    },response=>{
      response.resume();
      response.once('end',()=>resolve(response.statusCode??0));
    });
    request.once('error',reject);
    request.end('{}');
  });
}

test('MCP POST forwards only to the existing loopback Hub, preserving bearer and body',async()=>{
  const f=await fixture();try{
    const response=await fetch(f.url+'/mcp',{
      method:'POST',
      headers:{authorization,'content-type':'application/json',
        'x-forwarded-for':'10.0.0.5','cookie':'secret-cookie'},
      body:'{"tool":"ping"}',
    });
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{path:'/mcp',body:'{"tool":"ping"}'});
    assert.equal(f.received.length,1);
    assert.equal(f.received[0]?.authorization,authorization);
    assert.equal(f.received[0]?.host,'127.0.0.1:'+f.hubPort);
    assert.equal(f.received[0]?.spoof,undefined);
    assert.equal(response.headers.get('x-unsafe-header'),null);
  }finally{await f.close()}
});

test('no authorization does not contact a potentially misconfigured Hub',async()=>{
  const f=await fixture();try{
    const response=await fetch(f.url+'/mcp',{method:'POST',body:'{}'});
    assert.equal(response.status,401);
    assert.equal(f.received.length,0);
  }finally{await f.close()}
});

test('all non-MCP routes, /agent websocket paths, query variants and CONNECT are blocked',async()=>{
  const f=await fixture();try{
    for(const route of ['/agent','/health','/admin','/mcp?user=1',
      '/mcp/../health','/%6dcp','/.well-known/oauth-authorization-server']){
      const response=await fetch(f.url+route,{method:'POST',headers:{authorization}});
      assert.equal(response.status,404,route);
    }
    assert.equal(f.received.length,0);
  }finally{await f.close()}
});

test('GET/DELETE for MCP denied but protected-resource metadata forwarded',async()=>{
  const f=await fixture();try{
    for(const method of ['GET','DELETE']){
      const response=await fetch(f.url+'/mcp',{method});
      assert.equal(response.status,405);
    }
    const metadata=await fetch(f.url+'/.well-known/oauth-protected-resource/mcp');
    assert.equal(metadata.status,200);
    assert.deepEqual(f.received.map(x=>x.path),
      ['/.well-known/oauth-protected-resource/mcp']);
  }finally{await f.close()}
});

test('explicit public hostname and Origin allow only expected HTTPS domain',async()=>{
  const f=await fixture({publicHostname:'device.example.test'});try{
    const valid=await rawPostWithHeaders(f.url+'/mcp',
      {authorization,host:'device.example.test',origin:'https://device.example.test'});
    assert.equal(valid,200);
    for(const args of [
      {host:'attacker.example.test',origin:'https://device.example.test'},
      {host:'device.example.test',origin:'https://attacker.example.test'},
      {host:'device.example.test',origin:'http://device.example.test'},
      {host:'device.example.test:443',origin:'https://device.example.test'},
    ]){
      const response=await rawPostWithHeaders(f.url+'/mcp',{authorization,...args});
      assert.equal(response,403,JSON.stringify(args));
    }
    assert.equal(f.received.length,1);
  }finally{await f.close()}
});

test('random-domain Host cannot target origin when public hostname not configured',async()=>{
  const f=await fixture();try{
    const response=await rawPostWithHeaders(f.url+'/mcp',
      {authorization,host:'evil.example'});
    assert.equal(response,403);
    assert.equal(f.received.length,0);
  }finally{await f.close()}
});

test('large Content-Length is denied before contacting Hub',async()=>{
  const f=await fixture({maxRequestBytes:1024});try{
    const response=await fetch(f.url+'/mcp',{
      method:'POST',headers:{authorization},body:'x'.repeat(1100),
    });
    assert.equal(response.status,413);
    assert.equal(f.received.length,0);
  }finally{await f.close()}
});

test('unavailable local Hub fails closed with 502, no unhandled promise',async()=>{
  const f=await fixture();try{
    await close(f.hub);
    const response=await fetch(f.url+'/mcp',{
      method:'POST',headers:{authorization},body:'{}',
    });
    assert.equal(response.status,502);
    assert.deepEqual(await response.json(),{error:'local_hub_unavailable'});
    f.ingress.closeAllConnections();
    await new Promise<void>(resolve=>f.ingress.close(()=>resolve()));
  }finally{
    // The upstream and ingress were intentionally closed separately.
  }
});

test('invalid ports, equal ports, wildcard, IP and quick tunnels are rejected',()=>{
  for(const opts of [
    {hubPort:0,listenPort:43111},
    {hubPort:43110,listenPort:43110},
    {hubPort:43110,listenPort:65536},
    {hubPort:43110,listenPort:43111,publicHostname:'*.example.com'},
    {hubPort:43110,listenPort:43111,publicHostname:'127.0.0.1'},
    {hubPort:43110,listenPort:43111,publicHostname:'demo.trycloudflare.com'},
    {hubPort:43110,listenPort:43111,maxConcurrent:0},
    {hubPort:43110,listenPort:43111,maxRequestBytes:1},
  ])assert.throws(()=>validateLocalFirstIngress(opts));
});


test('public hostname preflight demands verified local Hub and exact OAuth metadata',async()=>{
  const resource='https://device.example.test/mcp';
  const calls:string[]=[];
  const success:typeof fetch=async input=>{
    const endpoint=String(input);
    calls.push(endpoint);
    if(endpoint.endsWith('/health'))return Response.json({
      ok:true,service:'nexowire',runtime:{ownerOauthConfigured:true},
    });
    return Response.json({resource,authorization_servers:['https://login.example.test']});
  };
  await verifyLocalFirstPublicUpstream({hubPort:43110,expectedResourceUrl:resource,fetchImpl:success});
  assert.deepEqual(calls,[
    'http://127.0.0.1:43110/health',
    'http://127.0.0.1:43110/.well-known/oauth-protected-resource/mcp',
  ]);
  for(const failed of [
    async()=>Response.json({ok:true,service:'nexowire',
      runtime:{ownerOauthConfigured:false}}),
    async(input:URL|Request|string)=>String(input).endsWith('/health')
      ? Response.json({ok:true,service:'nexowire',
          runtime:{ownerOauthConfigured:true}})
      : Response.json({resource:'https://other.test/mcp',
          authorization_servers:['https://login.example.test']}),
    async()=>new Response('offline',{status:503}),
  ]) {
    await assert.rejects(verifyLocalFirstPublicUpstream({
      hubPort:43110,expectedResourceUrl:resource,
      fetchImpl:failed as typeof fetch,
    }));
  }
  await assert.rejects(verifyLocalFirstPublicUpstream({
    hubPort:43110,expectedResourceUrl:'http://device.example.test/mcp',
    fetchImpl:success,
  }));
});

test('MCP prefix masquerade is not allowed',async()=>{
  const f=await fixture();try{
    for(const route of ['/mcp-other','/mcp/','/mcp%2fagent']){
      const response=await fetch(f.url+route,{method:'POST',headers:{authorization}});
      assert.equal(response.status,404);
    }
    assert.equal(f.received.length,0);
  }finally{await f.close()}
});
