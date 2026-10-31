/** Real disposable mTLS sockets; no production keys, ledger or human ceremony. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {request} from 'node:https';
import {connect as tcpConnect} from 'node:net';
import {connect as tlsConnect} from 'node:tls';
import type {AddressInfo} from 'node:net';
import {createCoreNativeVerifierServer} from '../src/security/core-native-verifier-server.js';

test('bounded native verifier host: actual mTLS, admission, deadlines and overload',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nx-verifier-host-'));
  let openssl='';
  for(const bin of ['openssl','C:\\Program Files\\Git\\usr\\bin\\openssl.exe']){
    try{execFileSync(bin,['version'],{stdio:'ignore'});openssl=bin;break}catch{}
  }
  assert.ok(openssl,'OpenSSL required; do not silently skip transport acceptance');
  const run=(args:string[])=>execFileSync(openssl,args,{cwd:root,stdio:'ignore',timeout:15000});
  run(['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes',
    '-keyout','ca.key','-out','ca.crt','-days','1','-subj','/CN=Disposable Host Test CA',
    '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  for(const name of ['server','client','expired-client']){
    await writeFile(path.join(root,name+'.ext'),'basicConstraints=critical,CA:FALSE\n'+
      'keyUsage=critical,digitalSignature\nextendedKeyUsage='+
      (name==='server'?'serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n':'clientAuth\n'));
    run(['req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes',
      '-keyout',name+'.key','-out',name+'.csr','-subj','/CN=Disposable '+name]);
    run(['x509','-req','-in',name+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial',
      '-out',name+'.crt','-days',name==='expired-client'?'0':'1','-extfile',name+'.ext']);
  }
  const pem=async(n:string)=>readFile(path.join(root,n),'utf8');
  const material={keyPem:await pem('server.key'),certificatePem:await pem('server.crt'),
    clientCaPem:await pem('ca.crt')};
  const client={key:await pem('client.key'),cert:await pem('client.crt'),ca:material.clientCaPem};
  let calls=0,hold=false,release:undefined|(()=>void);
  const handler=(_req:import('node:http').IncomingMessage,res:import('node:http').ServerResponse)=>{
    calls++;if(hold){release=()=>res.end('ok')}else res.end('ok');
  };
  const config={...material,handler,maxActiveRequests:1,maxConnections:4,
    headerDeadlineMs:1000,requestDeadlineMs:250};
  const server=createCoreNativeVerifierServer(config);
  assert.equal(server.listening,false,'constructing does not bind a port');
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as AddressInfo).port;
  const call=(withCert=true,maxVersion:'TLSv1.2'|'TLSv1.3'='TLSv1.3')=>new Promise<number>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path:'/v1/core-native-consent',method:'POST',
      agent:false,ca:client.ca,...(withCert?{key:client.key,cert:client.cert}:{}),
      minVersion:maxVersion,maxVersion},res=>{res.resume();res.once('end',()=>resolve(res.statusCode!))});
    req.setTimeout(2000,()=>req.destroy(Error('test deadline')));req.once('error',reject);req.end('{}');
  });
  try{
    await t.test('valid peer reaches handler; missing certificate and TLS downgrade never do',async()=>{
      assert.equal(await call(),200);assert.equal(calls,1);
      await assert.rejects(call(false));await assert.rejects(call(true,'TLSv1.2'));assert.equal(calls,1);
    });
    await t.test('expired client certificate cannot authenticate or reach authority',async()=>{
      const expiredCert=await pem('expired-client.crt');
      const expires=Date.parse(new X509Certificate(expiredCert).validTo);
      assert.ok(Number.isFinite(expires),'disposable certificate must have a parseable expiration');
      while(Date.now()<=expires)await new Promise(r=>setTimeout(r,25));
      const awaitedExpiredKey=await pem('expired-client.key');
      const before=calls;
      await assert.rejects(new Promise<void>((resolve,reject)=>{
        const req=request({hostname:'127.0.0.1',port,path:'/v1/core-native-consent',
          method:'POST',agent:false,key:awaitedExpiredKey,cert:expiredCert,ca:client.ca,
          minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},res=>{
            res.resume();resolve();
          });
        req.setTimeout(2000,()=>req.destroy(Error('expired certificate handshake deadline')));
        req.once('error',reject);req.end('{}');
      }));
      assert.equal(calls,before,'expired peer must not dispatch');
    });
    await t.test('configuration is detached; concurrent excess is rejected without dispatch',async()=>{
      config.maxActiveRequests=64;config.handler=()=>{throw Error('alias must not replace handler')};
      hold=true;const first=call();const outcome=first.catch(()=>0);
      for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,2));
      assert.ok(release);assert.equal(await call(),503);assert.equal(calls,2);
      release();assert.equal(await outcome,200);release=undefined;hold=false;
      assert.equal(await call(),200,'released slot accepts fresh work');
    });
    await t.test('absolute handler deadline terminates unknown work and frees capacity',async()=>{
      hold=true;const before=calls;const result=await call().catch(()=>0);
      assert.ok(result===503||result===0);assert.equal(calls,before+1);
      release=undefined;hold=false;assert.equal(await call(),200);
    });
    await t.test('excess headers and Expect bypass do not reach the handler',async()=>{
      const invoke=(headers:Record<string,string>)=>new Promise<number>((resolve,reject)=>{
        const req=request({hostname:'127.0.0.1',port,agent:false,...client,method:'POST',headers},res=>{
          res.resume();res.once('end',()=>resolve(res.statusCode!))});
        req.setTimeout(2000,()=>req.destroy(Error('test header deadline')));req.once('error',reject);req.end();
      });
      const before=calls;
      const excess=Object.fromEntries(Array.from({length:40},(_,i)=>['x-field-'+i,'v']));
      assert.equal(await invoke(excess),431);
      assert.equal(await invoke({expect:'100-continue'}),417);
      assert.equal(calls,before);
    });
    await t.test('TCP connection cap rejects additional idle peers without authority work',async()=>{
      const waitEmpty=async()=>{
        for(let i=0;i<100;i++){
          const n=await new Promise<number>((resolve,reject)=>server.getConnections((e,n)=>e?reject(e):resolve(n)));
          if(n===0)return;await new Promise(r=>setTimeout(r,5));
        }
        throw Error('fixture sockets did not drain');
      };
      await waitEmpty();const sockets:import('node:net').Socket[]=[];const before=calls;
      try{
        for(let i=0;i<4;i++){
          const socket=tcpConnect({host:'127.0.0.1',port});socket.on('error',()=>{});sockets.push(socket);
          await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)});
        }
        const extra=tcpConnect({host:'127.0.0.1',port});extra.on('error',()=>{});sockets.push(extra);
        await Promise.race([new Promise<void>(r=>extra.once('close',()=>r())),
          new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('connection cap leak')),500).unref())]);
        assert.equal(calls,before);
      }finally{for(const socket of sockets)socket.destroy();await waitEmpty()}
    });
    await t.test('idle TCP handshake and trickled authenticated headers are bounded',async()=>{
      const idle=tcpConnect({host:'127.0.0.1',port});idle.on('error',()=>{});
      const idleClosed=new Promise<void>(r=>idle.once('close',()=>r()));
      try{await Promise.race([idleClosed,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('idle TLS leak')),2500).unref())]);}
      finally{idle.destroy()}
      const socket=tlsConnect({host:'127.0.0.1',port,...client,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'});
      socket.on('error',()=>{});await new Promise<void>((resolve,reject)=>{socket.once('secureConnect',resolve);socket.once('error',reject)});
      const before=calls;socket.write('POST /v1/core-native-consent HTTP/1.1\r\nHost: localhost\r\nX-Slow: ');
      const drip=setInterval(()=>socket.write('a'),40);
      try{await Promise.race([new Promise<void>(r=>socket.once('close',()=>r())),
        new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('slow header leak')),2500).unref())]);}
      finally{clearInterval(drip);socket.destroy()}
      assert.equal(calls,before,'partial headers never reach authority');
    });
    await t.test('invalid limits and missing protected material fail at construction',()=>{
      for(const bad of [{maxConnections:0},{maxActiveRequests:5},{headerDeadlineMs:Infinity},
        {requestDeadlineMs:15001},{clientCaPem:''}])
        assert.throws(()=>createCoreNativeVerifierServer({...material,handler,maxConnections:4,
          maxActiveRequests:1,...bad}),/HOST_CONFIGURATION_INVALID/);
    });
  }finally{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
