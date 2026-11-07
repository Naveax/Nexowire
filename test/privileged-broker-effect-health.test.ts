import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startPrivilegedBroker} from '../src/agent/privileged-broker.js';
import {PrivilegedBrokerClient} from '../src/agent/privileged-broker-client.js';
import type {BrokerExternalEffectAdmission} from '../src/agent/privileged-broker-effect-admission.js';

const TOKEN='disposable-broker-health-test-credential-12345';

test('Windows Broker health differentiates elevated transport from unconfigured effect admission', {
  skip:process.platform!=='win32',
},async t=>{
  let effects=0;
  const handle=await startPrivilegedBroker({
    host:'127.0.0.1',port:0,tokens:[TOKEN],requireElevation:false,
    execute:async()=>{effects++;return {unexpected:true};},
  });
  t.after(()=>handle.close());
  const client=new PrivilegedBrokerClient({url:handle.url,token:TOKEN});
  const status=await client.probe();
  assert.equal(status.reachable,true);
  assert.equal(status.effectAdmissionConfigured,false,
    'listening/elevation must not be confused with authority provisioning');
  const denied=await fetch(handle.url+'/execute',{
    method:'POST',headers:{authorization:'Bearer '+TOKEN,'content-type':'application/json'},
    body:JSON.stringify({
      operation_id:randomUUID(),capability:'windows.service.control',
      input:{action:'start',name:'Synthetic-Not-Installed'},
    }),
  });
  assert.equal(denied.status,400);
  const result=await denied.json() as {error?:{code?:string}};
  assert.equal(result.error?.code,'BROKER_EFFECT_ADMISSION_REQUIRED');
  assert.equal(effects,0,'no real elevated effect without an independent provider');
});

test('Windows Broker health advertises attached adapter only; does not claim per-effect authorization',{
  skip:process.platform!=='win32',
},async t=>{
  // Health never invokes the supplied provider. The adapter below is deliberately
  // inert and no real effect or control-plane call is attempted.
  const inertAdapter={} as BrokerExternalEffectAdmission;
  const handle=await startPrivilegedBroker({
    host:'127.0.0.1',port:0,tokens:[TOKEN],requireElevation:false,
    effectAdmission:inertAdapter,
  });
  t.after(()=>handle.close());
  const client=new PrivilegedBrokerClient({url:handle.url,token:TOKEN});
  const status=await client.probe();
  assert.equal(status.reachable,true);
  assert.equal(status.effectAdmissionConfigured,true);
  const rejected=new PrivilegedBrokerClient({
    url:handle.url,token:'different-disposable-test-token-12345',
  });
  const unauthenticated=await rejected.probe();
  assert.equal(unauthenticated.reachable,false);
  assert.equal(unauthenticated.effectAdmissionConfigured,null,
    'authentication failures must not reveal protected Broker health');
});
