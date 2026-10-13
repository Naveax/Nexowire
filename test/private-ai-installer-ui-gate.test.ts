import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPrivateAiGuiBoundary,executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import type {PrivilegedBrokerClient} from '../src/agent/privileged-broker-client.js';

function withAiMode<T>(mode:'private_desktop'|'headless',fn:()=>Promise<T>|T){
  const original=process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  const enforce=process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
  process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=mode;
  process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE=mode==='private_desktop'?'1':'0';
  return Promise.resolve().then(fn).finally(()=>{
    if(original===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
    else process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=original;
    if(enforce===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
    else process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE=enforce;
  });
}

test('private AI mode blocks elevated installer apply before Broker and disk side effects',{
  skip:process.platform!=='win32',
},async()=>withAiMode('private_desktop',async()=>{
  const payload={
    file_path:'C:\\Users\\Example\\Downloads\\setup.exe',
    sha256:'a'.repeat(64),
  };
  let brokerCalls=0;
  const broker={execute:async()=>{
    brokerCalls++;
    return {unexpected:true};
  }} as unknown as PrivilegedBrokerClient;
  const policy=new PathPolicy(['*']);
  assert.throws(()=>assertPrivateAiGuiBoundary('windows.installer.apply'),
    (error:unknown)=>error instanceof Error&&
      'code' in error&&error.code==='AI_PRIVATE_INSTALLER_UI_NOT_ISOLATED'&&
      'capability' in error&&error.capability==='windows.installer.apply');
  for(const context of [
    {accessMode:'full' as const,privilegeMode:'broker' as const,privilegedBroker:broker},
    {accessMode:'safe' as const,privilegeMode:'broker' as const,privilegedBroker:broker},
    {accessMode:'full' as const,privilegeMode:'direct' as const,privilegedBroker:broker},
  ]){
    await assert.rejects(
      executeCapability('windows.installer.apply',payload,policy,context),
      (error:unknown)=>error instanceof Error&&
        'code' in error&&error.code==='AI_PRIVATE_INSTALLER_UI_NOT_ISOLATED',
    );
  }
  assert.equal(brokerCalls,0,'Even approved full-mode Broker must not be called');
}));

test('read-only installer preflight/status and unrelated private desktop controls remain eligible',{
  skip:process.platform!=='win32',
},async()=>withAiMode('private_desktop',()=>{
  for(const capability of [
    'windows.installer.preflight',
    'windows.installer.status',
    'windows.private_desktop.launch',
    'windows.private_display.readiness',
    'windows.uac.status',
  ] as const){
    assert.doesNotThrow(()=>assertPrivateAiGuiBoundary(capability),capability);
  }
}));

test('normal compatibility mode retains existing owner-approved Broker installer behavior',{
  skip:process.platform!=='win32',
},async()=>withAiMode('headless',async()=>{
  assert.doesNotThrow(()=>assertPrivateAiGuiBoundary('windows.installer.apply'));
  let calls=0;
  const broker={execute:async()=>{
    calls++;return {scheduled:true};
  }} as unknown as PrivilegedBrokerClient;
  const result=await executeCapability(
    'windows.installer.apply',{file_path:'C:\\Test\\setup.exe'},
    new PathPolicy(['*']),{
      accessMode:'full',privilegeMode:'broker',privilegedBroker:broker,
    },
  );
  assert.deepEqual(result,{scheduled:true});
  assert.equal(calls,1);
}));

test('implementation acknowledges WindowStyle Hidden cannot isolate shell-brokered child GUI',async()=>{
  const source=await import('node:fs/promises').then(fs=>
    fs.readFile(new URL('../src/agent/windows-installer-job.ts',import.meta.url),'utf8'));
  assert.match(source,/Start-Process -FilePath \$program/);
  assert.match(source,/-WindowStyle Hidden/);
  const dispatch=await import('node:fs/promises').then(fs=>
    fs.readFile(new URL('../src/agent/executors.ts',import.meta.url),'utf8'));
  assert.match(dispatch,/AI_PRIVATE_INSTALLER_UI_NOT_ISOLATED/);
  assert.match(dispatch,/before physical console grant checks/);
});
