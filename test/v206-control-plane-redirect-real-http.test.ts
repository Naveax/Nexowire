import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createControlPlaneAgentCredentialVerifier,createControlPlaneAgentPresenceReporter} from '../src/hub/control-plane-agent-auth.js';

/** Real loopback HTTP/307 collector, never Cloudflare, DNS, user tokens or production. */
async function listen(server:Server):Promise<number>{
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
  });
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  return (address as AddressInfo).port;
}
async function close(server:Server):Promise<void>{
  server.closeAllConnections();
  await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
}
async function redirectFixture(t:import('node:test').TestContext){
  const collector:{authorization:string|undefined;method:string|undefined;deviceCredentialInBody:boolean;presenceDeviceIdInBody:boolean}[]=[];
  let redirects=0;
  const sink=createServer((req,res)=>{
    const chunks:Buffer[]=[];
    req.on('data',(chunk:Buffer)=>chunks.push(chunk));
    req.once('end',()=>{
      const body=Buffer.concat(chunks).toString('utf8');
      collector.push({authorization:req.headers.authorization,method:req.method,
        deviceCredentialInBody:body.includes('nwx_dev_'),
        presenceDeviceIdInBody:body.includes('disposable-device-01')});
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({authenticated:true,device:{deviceId:'disposable-device-01'},updated:true}));
    });
  });
  const sinkPort=await listen(sink);
  t.after(()=>close(sink));
  const source=createServer((req,res)=>{
    assert.equal(req.method,'POST');
    redirects++;
    req.resume();
    res.writeHead(307,{location:'http://127.0.0.1:'+sinkPort+'/collector',
      'cache-control':'no-store'});
    res.end();
  });
  const port=await listen(source);
  t.after(()=>close(source));
  return {base:'http://127.0.0.1:'+port,collector,get redirects(){return redirects;}};
}

test('V2-06 P1-C real HTTP 307 cannot forward Agent authentication secrets', {timeout:8000},async t=>{
  const f=await redirectFixture(t);
  const verifier=createControlPlaneAgentCredentialVerifier({
    controlPlaneUrl:f.base,
    serviceToken:'disposable-service-token-only-0123456789',
    timeoutMs:1500,
  });
  const authorization=await verifier('Bearer nwx_dev_disposable_device_0123456789');
  assert.equal(f.redirects,1,'disposable redirect response must actually be reached');
  if(f.collector.length)t.diagnostic('Redirect collector: requests='+f.collector.length+
    ', device-credential-in-body='+f.collector.some(v=>v.deviceCredentialInBody)+
    ', authorization-header-present='+f.collector.some(v=>Boolean(v.authorization)));
  assert.equal(f.collector.length,0,'HTTP 307 destination must receive ZERO device/service credentials');
  assert.equal(authorization,undefined,'remote redirect must never authenticate a device');
});

test('V2-06 P1-C real HTTP 307 cannot forward Agent presence service token', {timeout:8000},async t=>{
  const f=await redirectFixture(t);
  const report=createControlPlaneAgentPresenceReporter({
    controlPlaneUrl:f.base,
    serviceToken:'disposable-service-token-only-0123456789',
    timeoutMs:1500,
  });
  const accepted=await report({deviceId:'disposable-device-01',online:false,at:'2026-11-04T00:00:00.000Z'});
  assert.equal(f.redirects,1,'disposable redirect response must actually be reached');
  if(f.collector.length)t.diagnostic('Redirect collector: requests='+f.collector.length+
    ', presence-device-id-in-body='+f.collector.some(v=>v.presenceDeviceIdInBody)+
    ', authorization-header-present='+f.collector.some(v=>Boolean(v.authorization)));
  assert.equal(f.collector.length,0,'HTTP 307 destination must receive ZERO presence service credentials');
  assert.equal(accepted,false,'a redirect must never count as authenticated presence update');
});
