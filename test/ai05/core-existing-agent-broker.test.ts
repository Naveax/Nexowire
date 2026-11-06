import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveNativeAgentPrivilegeMode} from '../../src/agent/native-agent.js';

test('existing Windows CORE launcher discovers a ready Broker without reinstall',async()=>{
  const env={NEXOWIRE_CORE_AUTHORITY_URL:'https://core.example.test'};
  let calls=0;
  assert.equal(await resolveNativeAgentPrivilegeMode(env,'win32',async()=>{
    calls++; return {ready:true};
  }),'broker');
  assert.equal(calls,1);
  assert.deepEqual(env,{NEXOWIRE_CORE_AUTHORITY_URL:'https://core.example.test'});
});

test('explicit modes and non-CORE/non-Windows Agents never probe or change mode',async()=>{
  const never=async()=>{throw Error('unexpected probe');};
  for(const mode of ['direct','broker'] as const){
    assert.equal(await resolveNativeAgentPrivilegeMode({
      NEXOWIRE_CORE_AUTHORITY_URL:'https://core.example.test',
      NEXOWIRE_PRIVILEGE_MODE:mode,
    },'win32',never),mode);
  }
  assert.equal(await resolveNativeAgentPrivilegeMode({},'win32',never),'direct');
  assert.equal(await resolveNativeAgentPrivilegeMode({
    NEXOWIRE_CORE_AUTHORITY_URL:'https://core.example.test',
  },'linux',never),'direct');
});

test('unavailable or failed optional Broker discovery preserves ordinary connectivity',async()=>{
  const env={NEXOWIRE_CORE_AUTHORITY_URL:'https://core.example.test'};
  assert.equal(await resolveNativeAgentPrivilegeMode(env,'win32',async()=>({ready:false})),'direct');
  assert.equal(await resolveNativeAgentPrivilegeMode(env,'win32',async()=>{throw Error('offline');}),'direct');
});

test('invalid explicit privilege mode is still reported rather than silently replaced',async()=>{
  await assert.rejects(resolveNativeAgentPrivilegeMode({
    NEXOWIRE_CORE_AUTHORITY_URL:'https://core.example.test',
    NEXOWIRE_PRIVILEGE_MODE:'typo',
  },'win32',async()=>({ready:true})),/must be direct or broker/);
});
