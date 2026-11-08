import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWindowsCoreAgentInstallEnvironment}
  from '../../src/agent/native-agent-lifecycle.js';

test('CORE Windows install selects authenticated Broker when locally requested',async()=>{
  const original:NodeJS.ProcessEnv={NEXOWIRE_CORE_AUTHORITY_URL:'https://core.example.test',
    NEXOWIRE_HUB_WS_URL:'wss://hub.example.test/agent'};
  let probes=0;
  const result=await prepareWindowsCoreAgentInstallEnvironment(original,async()=>{
    probes++;return {ready:true,status:'READY'};
  });
  assert.equal(probes,1);
  assert.equal(result.NEXOWIRE_PRIVILEGE_MODE,'broker');
  assert.equal(original.NEXOWIRE_PRIVILEGE_MODE,undefined);
  assert.equal(result.NEXOWIRE_CORE_AUTHORITY_URL,original.NEXOWIRE_CORE_AUTHORITY_URL);
});

test('absence of CORE URL never changes legacy Agent direct mode',async()=>{
  const original:NodeJS.ProcessEnv={NEXOWIRE_HUB_WS_URL:'ws://127.0.0.1:43110/agent'};
  const result=await prepareWindowsCoreAgentInstallEnvironment(original,async()=>{
    throw new Error('should not probe');
  });
  assert.equal(result,original);
});

test('explicit direct mode cannot masquerade as a working CORE Broker',async()=>{
  const input:NodeJS.ProcessEnv={NEXOWIRE_CORE_AUTHORITY_URL:'https://core.example.test',
    NEXOWIRE_PRIVILEGE_MODE:'direct'};
  await assert.rejects(
    prepareWindowsCoreAgentInstallEnvironment(input,async()=>{
      throw Error('must not probe');
    }),
    /CORE_BROKER_MODE_REQUIRED/,
  );
});

test('unavailable Broker is reported before preparing a CORE Agent launcher',async()=>{
  const input:NodeJS.ProcessEnv={NEXOWIRE_CORE_AUTHORITY_URL:'https://core.example.test'};
  await assert.rejects(
    prepareWindowsCoreAgentInstallEnvironment(input,async()=>({
      ready:false,status:'SECRET_UNAVAILABLE',
    })),
    /CORE_BROKER_NOT_READY_SECRET_UNAVAILABLE/,
  );
  const explicit={...input,NEXOWIRE_PRIVILEGE_MODE:'broker'};
  await assert.rejects(
    prepareWindowsCoreAgentInstallEnvironment(explicit,async()=>({
      ready:false,status:'HEALTH_UNAVAILABLE',
    })),
    /CORE_BROKER_NOT_READY_HEALTH_UNAVAILABLE/,
  );
});
