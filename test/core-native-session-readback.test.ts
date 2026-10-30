import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {parseCoreNativeSessionReadback,compareCoreNativeSessionReadback,
  type CoreNativeSessionExpectation} from '../src/protocol/core-native-session-readback.js';

// Synthetic JSON exercises only the readback wire contract. It is not signed,
// authenticated, a protected native provider or evidence of human approval.
const now=1_800_000_000_000;
const binding:CoreNativeSessionExpectation={nonce:'a'.repeat(64),
  windowsUserSid:'S-1-5-21-111-222-333-1001',windowsSessionId:1,
  windowsLogonLuid:'000000000000abcd',processId:321,
  processCreationFileTime:'01dc000000000001'};
const observation={version:1,kind:'windows_core_session_readback_v1',nonce:binding.nonce,
  state:'OBSERVED',humanApproval:false,coreAuthority:false,observedAtMs:now,durationMs:1,
  processId:binding.processId,processCreationFileTime:binding.processCreationFileTime,
  tokenId:'0000000000001111',tokenModifiedId:'0000000000002222',
  windowsUserSid:binding.windowsUserSid,windowsSessionId:binding.windowsSessionId,
  windowsLogonLuid:binding.windowsLogonLuid,integrityRid:8192,elevated:false,
  activeConsoleSessionId:1,localProtocol:true,sessionActive:true,
  windowStationInteractive:true,threadDesktopDefault:true,inputDesktopDefault:true};
const json=(change:Record<string,unknown>={})=>JSON.stringify({...observation,...change});

test('a matching readback cannot grant CORE, physical approval or authenticate its own origin',()=>{
  const parsed=parseCoreNativeSessionReadback(json(),binding.nonce,now);
  assert.equal(parsed.state,'OBSERVED');
  assert.deepEqual(compareCoreNativeSessionReadback(json(),binding,now),{
    scopeMatches:true,reason:'UNATTESTED_SCOPE_MATCH_ONLY',originAuthenticated:false,
    humanApprovalVerified:false,canAuthorizeCore:false,physicalAcceptance:'NOT_PROVEN'});
});

for(const [field,value] of [
  ['windowsUserSid','S-1-5-21-111-222-333-1002'],['windowsSessionId',2],
  ['windowsLogonLuid','000000000000abce'],['processId',322],
  ['processCreationFileTime','01dc000000000002'],
] as const)test('readback denies substitution of '+field,()=>{
  const result=compareCoreNativeSessionReadback(json({[field]:value}),binding,now);
  assert.equal(result.scopeMatches,false);
  assert.equal(result.reason,'OWNER_PROCESS_SESSION_MISMATCH');
  assert.equal(result.canAuthorizeCore,false);
});

for(const [field,value] of [
  ['activeConsoleSessionId',2],['localProtocol',false],['sessionActive',false],
  ['windowStationInteractive',false],['threadDesktopDefault',false],['inputDesktopDefault',false],
] as const)test('remote, locked, private or disconnected context denies: '+field,()=>{
  const result=compareCoreNativeSessionReadback(json({[field]:value}),binding,now);
  assert.equal(result.scopeMatches,false);
  assert.equal(result.reason,'LOCAL_DEFAULT_CONSOLE_NOT_OBSERVED');
});

test('fresh challenges and bounded age reject replay, future and stale readback',()=>{
  for(const data of [json({nonce:'b'.repeat(64)}),json({observedAtMs:now+1}),
    json({observedAtMs:now-2001}),json({durationMs:2001})]){
    assert.throws(()=>parseCoreNativeSessionReadback(data,binding.nonce,now));
    assert.equal(compareCoreNativeSessionReadback(data,binding,now).canAuthorizeCore,false);
  }
  assert.equal(compareCoreNativeSessionReadback(json({observedAtMs:now-2000}),binding,now).scopeMatches,true);
  for(const invalid of [NaN,Infinity,-1,0,now+0.5,Number.MAX_SAFE_INTEGER+1])
    assert.throws(()=>parseCoreNativeSessionReadback(json(),binding.nonce,invalid));
});

test('approval flags, provider booleans and authority-looking extra fields are rejected',()=>{
  for(const field of ['humanApproval','coreAuthority','approved','verified',
    'nativeConsentProviderPresent','trustedProviderInstalled']){
    const raw=json({[field]:true});
    assert.throws(()=>parseCoreNativeSessionReadback(raw,binding.nonce,now));
    assert.equal(compareCoreNativeSessionReadback(raw,binding,now).scopeMatches,false);
  }
  assert.throws(()=>parseCoreNativeSessionReadback(json({physicalAcceptance:'PASS'}),binding.nonce,now));
});

test('readback is bounded JSON, not executable objects or implicit truthy values',()=>{
  let getters=0;
  const hostile={get state(){getters++;throw new Error('must not execute');}};
  for(const data of [hostile,null,[],42,'{','x'.repeat(8193),
    json({inputDesktopDefault:'true'}),json({elevated:1}),json({windowsSessionId:-1}),
    json({activeConsoleSessionId:0xffffffff}),json({windowsLogonLuid:'caller-logon'})])
    assert.throws(()=>parseCoreNativeSessionReadback(data,binding.nonce,now));
  assert.equal(getters,0);
});

test('unavailable native evidence remains non-authorizing, without fallback',()=>{
  const stdout=JSON.stringify({version:1,kind:observation.kind,nonce:binding.nonce,
    state:'UNAVAILABLE',humanApproval:false,coreAuthority:false,
    reason:'INPUT_DESKTOP_UNAVAILABLE',win32Error:5});
  const parsed=parseCoreNativeSessionReadback(stdout,binding.nonce,now);
  assert.equal(parsed.state,'UNAVAILABLE');
  const result=compareCoreNativeSessionReadback(stdout,binding,now);
  assert.equal(result.scopeMatches,false);assert.equal(result.canAuthorizeCore,false);
  assert.equal(result.humanApprovalVerified,false);
  assert.equal(result.reason,'INPUT_DESKTOP_UNAVAILABLE');
});

test('expected identity must be separately provided, complete and strict',()=>{
  for(const missing of ['nonce','windowsUserSid','windowsSessionId','windowsLogonLuid',
    'processId','processCreationFileTime']){
    const value={...binding} as Record<string,unknown>;delete value[missing];
    assert.equal(compareCoreNativeSessionReadback(json(),value as CoreNativeSessionExpectation,now).reason,
      'EXPECTED_SCOPE_INVALID');
  }
  assert.equal(compareCoreNativeSessionReadback(json(),{...binding,approved:true} as
    CoreNativeSessionExpectation,now).scopeMatches,false);
});

test('real Windows witness reports only OS observations or explicit unavailability',
  {skip:process.platform!=='win32',timeout:20000},t=>{
    const challenge=randomBytes(32).toString('hex');
    const executable=path.resolve('native/windows-core-session-readback.exe');
    const result=spawnSync(executable,['--readback',challenge],
      {shell:false,windowsHide:true,encoding:'utf8',timeout:8000,maxBuffer:8192});
    assert.equal(result.error,undefined,'native readback process must run within its bound');
    const value=parseCoreNativeSessionReadback(result.stdout,challenge,Date.now());
    assert.equal(value.humanApproval,false);assert.equal(value.coreAuthority,false);
    if(value.state==='OBSERVED'){
      assert.equal(result.status,0);assert.equal(value.processId,result.pid);
      t.diagnostic('OS_OBSERVATION_ONLY: kernel token/session read; human approval and CORE authority NOT_PROVEN');
    }else{
      assert.equal(result.status,77);
      t.diagnostic('READBACK_UNAVAILABLE_WITHOUT_AUTHORITY: '+value.reason);
    }
    for(const args of [['--approve',challenge],['--readback','invalid'],
      ['--readback',challenge,'--grant-core']]){
      const invalid=spawnSync(executable,args,
        {shell:false,windowsHide:true,encoding:'utf8',timeout:3000,maxBuffer:8192});
      assert.equal(invalid.error,undefined);assert.equal(invalid.status,64);
      assert.equal(invalid.stdout,'');
    }
  });
