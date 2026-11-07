import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probePrivilegedBrokerHealth } from '../src/agent/privileged-broker-lifecycle.js';
import { readExistingPrivilegedBrokerToken } from '../src/security/privileged-broker-secret.js';
import { startPrivilegedBroker, isWindowsProcessElevated } from '../src/agent/privileged-broker.js';
import { NEXOWIRE_VERSION } from '../src/version.js';

const envFor = (url: string) => ({...process.env,
  NEXOWIRE_PRIVILEGED_BROKER_URL: url,
  NEXOWIRE_PRIVILEGED_BROKER_TOKEN: '',
  NEXOWIRE_PRIVILEGED_BROKER_TOKENS: '',
});

test('auth probe reports actual token elevation and separates unavailable effect admission', {
  skip: process.platform !== 'win32',
}, async () => {
  const token = 'test-broker-health-token-012345';
  const server = await startPrivilegedBroker({
    host:'127.0.0.1', port:0, tokens:[token], requireElevation:false,
  });
  try {
    const report = await probePrivilegedBrokerHealth({
      env:envFor(server.url), readToken:async () => token,
    });
    const actuallyElevated=isWindowsProcessElevated();
    assert.deepEqual(report, {
      expectedVersion:NEXOWIRE_VERSION,
      version:NEXOWIRE_VERSION,
      reachable:true,
      elevated:actuallyElevated,
      effectAdmissionConfigured:false,
      effectAdmissionState:actuallyElevated?'PROVIDER_NOT_CONFIGURED':'TRANSPORT_NOT_READY',
      ready:actuallyElevated,
      status:actuallyElevated?'READY':'NOT_ELEVATED',
    });
    const denied = await probePrivilegedBrokerHealth({
      env:envFor(server.url), readToken:async () => 'different-token',
    });
    assert.equal(denied.ready,false);
    assert.equal(denied.status,'HEALTH_UNAVAILABLE');
  } finally {
    await server.close();
  }
});

async function mockBroker(health: {ok:boolean;elevated:boolean;version:string;effectAdmissionConfigured?:boolean} | null,
  check:(url:string)=>Promise<void>) {
  const server=createServer((req,res)=>{
    if(req.url!=='/health'){res.writeHead(404);res.end();return}
    if(req.headers.authorization!=='Bearer fixture-token') {
      res.writeHead(401);res.end();return;
    }
    if(!health){res.writeHead(404);res.end();return}
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify(health));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const addr=server.address();
  assert.ok(addr && typeof addr!=='string');
  try {await check('http://127.0.0.1:'+addr.port);}
  finally {await new Promise<void>((done)=>server.close(()=>done()));}
}

test('valid authentication with older version does not imply ready',async()=>{
  await mockBroker({ok:true,elevated:true,version:'1.0.4'},async(url)=>{
    const report=await probePrivilegedBrokerHealth({
      env:envFor(url),readToken:async()=> 'fixture-token',
    });
    assert.equal(report.reachable,true);
    assert.equal(report.elevated,true);
    assert.equal(report.version,'1.0.4');
    assert.equal(report.ready,false);
    assert.equal(report.status,'VERSION_MISMATCH');
  });
});

test('broker that is not elevated fails closed',async()=>{
  await mockBroker({ok:true,elevated:false,version:NEXOWIRE_VERSION},async(url)=>{
    const report=await probePrivilegedBrokerHealth({
      env:envFor(url),readToken:async()=> 'fixture-token',
    });
    assert.equal(report.status,'NOT_ELEVATED');
    assert.equal(report.ready,false);
  });
});

test('missing /health and unavailable token never grant readiness',async()=>{
  await mockBroker(null,async(url)=>{
    const notFound=await probePrivilegedBrokerHealth({
      env:envFor(url),readToken:async()=> 'fixture-token',
    });
    assert.equal(notFound.status,'HEALTH_UNAVAILABLE');
    const absentSecret=await probePrivilegedBrokerHealth({
      env:envFor(url),readToken:async()=>{throw new Error('missing');},
    });
    assert.equal(absentSecret.status,'SECRET_UNAVAILABLE');
    assert.equal(absentSecret.version,null);
    assert.equal(absentSecret.ready,false);
  });
});

test('explicit plaintext token variables and non-loopback URL are rejected',async()=>{
  await assert.rejects(
    probePrivilegedBrokerHealth({
      env:{...envFor('http://127.0.0.1:43112'),NEXOWIRE_PRIVILEGED_BROKER_TOKEN:'forbidden'},
      readToken:async()=> 'unused',
    }),
    /BROKER_PROBE_REQUIRES_PROTECTED_SECRET/,
  );
  await assert.rejects(
    probePrivilegedBrokerHealth({
      env:envFor('http://example.org:80'),readToken:async()=> 'fixture-token',
    }),
    /loopback/,
  );
});

test('readExisting broker secret never creates a missing DPAPI file', {
  skip:process.platform!=='win32',
},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-readonly-token-'));
  const target=path.join(root,'nonexistent.json');
  try{
    await assert.rejects(readExistingPrivilegedBrokerToken({file:target}),/ENOENT/);
    await assert.rejects(fs.stat(target),/ENOENT/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Broker effect admission preflight distinguishes missing, legacy and unverified providers',async()=>{
  for(const entry of [
    {configured:false,expected:'PROVIDER_NOT_CONFIGURED'},
    {configured:true,expected:'PROVIDER_CONFIGURED_UNVERIFIED'},
    {configured:undefined,expected:'LEGACY_UNKNOWN'},
  ] as const){
    const health={
      ok:true,elevated:true,version:NEXOWIRE_VERSION,
      ...(entry.configured===undefined?{}:{effectAdmissionConfigured:entry.configured}),
    };
    await mockBroker(health,async(url)=>{
      const report=await probePrivilegedBrokerHealth({
        env:envFor(url),
        readToken:async()=> 'fixture-token',
      });
      assert.equal(report.status,'READY','legacy callers still get transport readiness');
      assert.equal(report.ready,true);
      assert.equal(report.effectAdmissionState,entry.expected);
      assert.equal(report.effectAdmissionConfigured,entry.configured??null);
      assert.doesNotMatch(JSON.stringify(report),/fixture-token/);
    });
  }
});
