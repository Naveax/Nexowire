import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {
  classifyPrivilegedBrokerModeEvidence,
  probeBrokerLoopbackListener,
  verifyPrivilegedBrokerModePostcondition,
} from '../src/agent/privileged-broker-mode-evidence.js';
import type {
  PrivilegedBrokerTaskStatus,
  PrivilegedBrokerHealthReport,
} from '../src/agent/privileged-broker-lifecycle.js';

const task=(state:string):PrivilegedBrokerTaskStatus=>({
  installed:true,taskName:'Nexowire Privileged Broker',
  state,lastRunTime:null,lastTaskResult:0,nextRunTime:null,
});
const healthy:PrivilegedBrokerHealthReport={
  expectedVersion:'1.0.5',version:'1.0.5',
  reachable:true,elevated:true,ready:true,status:'READY',
};

test('OFF is not applied while listener is present, timed out or task is active',()=>{
  assert.equal(classifyPrivilegedBrokerModeEvidence('off',task('Disabled'),'absent',null).applied,true);
  for(const state of ['present','unverified'] as const)
    assert.equal(classifyPrivilegedBrokerModeEvidence('off',task('Disabled'),state,null).applied,false);
  assert.equal(classifyPrivilegedBrokerModeEvidence('off',task('Running'),'absent',null).applied,false);
  assert.equal(classifyPrivilegedBrokerModeEvidence('off',{...task('Disabled'),installed:false},'absent',null).applied,false);
  assert.equal(classifyPrivilegedBrokerModeEvidence('off',{...task('Disabled'),taskName:'Other Task'},'absent',null).applied,false);
});

test('ON/AUTO only apply with Running task and authenticated expected-version health',()=>{
  for(const mode of ['on','auto'] as const) {
    assert.equal(classifyPrivilegedBrokerModeEvidence(mode,task('Running'),'present',healthy).applied,true);
    assert.equal(classifyPrivilegedBrokerModeEvidence(mode,task('Ready'),'present',healthy).applied,false);
    assert.equal(classifyPrivilegedBrokerModeEvidence(mode,task('Running'),'absent',healthy).applied,false);
    assert.equal(classifyPrivilegedBrokerModeEvidence(mode,task('Running'),'unverified',healthy).applied,false);
    for(const variant of [
      {...healthy,ready:false},
      {...healthy,reachable:false},
      {...healthy,elevated:false},
      {...healthy,version:'old-version'},
      {...healthy,status:'SECRET_UNAVAILABLE' as const},
    ]) {
      assert.equal(classifyPrivilegedBrokerModeEvidence(mode,task('Running'),'present',variant).applied,false);
    }
  }
});

test('read-only verified mode postconditions use task and listener checks',async()=>{
  let healthCalls=0;
  const off=await verifyPrivilegedBrokerModePostcondition('off',{
    readTask:async()=>task('Disabled'),
    probeListener:async()=> 'absent',
    readHealth:async()=>{ healthCalls+=1;return healthy; },
  });
  assert.equal(off.applied,true);
  assert.equal(healthCalls,0);
  const on=await verifyPrivilegedBrokerModePostcondition('on',{
    readTask:async()=>task('Running'),
    probeListener:async()=> 'present',
    readHealth:async()=>{ healthCalls+=1;return healthy; },
  });
  assert.equal(on.applied,true);
  assert.equal(on.brokerHealth,'authenticated-ready');
  assert.equal(healthCalls,1);
});

test('noncanonical health URLs and invalid mode fail closed before probing',async()=>{
  await assert.rejects(
    verifyPrivilegedBrokerModePostcondition('unexpected' as 'on',{
      readTask:async()=>{throw new Error('SHOULD_NOT_QUERY_TASK');},
    }),/BROKER_MODE_INVALID/,
  );
  await assert.rejects(
    verifyPrivilegedBrokerModePostcondition('on',{
      env:{NEXOWIRE_PRIVILEGED_BROKER_URL:'http://evil.example:43112'},
      readTask:async()=>{throw new Error('SHOULD_NOT_QUERY_TASK');},
    }),/BROKER_NONCANONICAL_HEALTH_ENDPOINT/,
  );
});

test('loopback TCP probe distinguishes open socket from confirmed refusal without mutation',async()=>{
  const server=createServer(socket=>socket.destroy());
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const addr=server.address();
  assert.ok(addr && typeof addr!=='string');
  const port=addr.port;
  try {
    assert.equal(await probeBrokerLoopbackListener(port), 'present');
  } finally {
    await new Promise<void>((resolve,reject)=>
      server.close(err=>err?reject(err):resolve()));
  }
  assert.equal(await probeBrokerLoopbackListener(port),'absent');
  await assert.rejects(probeBrokerLoopbackListener(0),/BROKER_LOOPBACK_PROBE_INVALID_ARGUMENT/);
  await assert.rejects(probeBrokerLoopbackListener(43112,5),/BROKER_LOOPBACK_PROBE_INVALID_ARGUMENT/);
});
