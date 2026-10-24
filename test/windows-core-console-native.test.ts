import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CORE_NATIVE_DEFINITION,executeCoreConsoleNative,parseCoreNativeInput,runCorePowerShell} from '../src/agent/windows-core-console-native.js';
import {WindowsCoreProfileStore} from '../src/agent/windows-core-console-provider.js';
import {canonicalCoreConsoleEnrollment} from '../src/agent/core-console-enrollment-policy.js';

test('physical native dispatcher rejects arbitrary shell, malformed targets and remote approval flags',()=>{
  for(const cap of ['shell.exec','windows.service.control','windows.registry.set','core.shell.exec'])
    assert.throws(()=>parseCoreNativeInput(cap,{}),/SCOPE_DENIED/);
  assert.throws(()=>parseCoreNativeInput('windows.keyboard.type',{hwnd:'1;Stop-Process',text:'x'}));
  assert.throws(()=>parseCoreNativeInput('windows.pointer.click',{hwnd:'1',x:2,y:0,coordinate_mode:'normalized'}));
  assert.throws(()=>parseCoreNativeInput('windows.keyboard.type',{hwnd:'1',text:'x',approved:true}));
});

test('real Windows native fence compiles and obeys actual desktop/integrity and persistent STOP',
  {skip:process.platform!=='win32'},async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-core-native-'));
    try{
      const source=`$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${CORE_NATIVE_DEFINITION}\n'@\n@{allowed=[NxCoreConsole]::DesktopAllowed()}|ConvertTo-Json -Compress`;
      const observed=await runCorePowerShell(source,{},undefined,180000) as {allowed:boolean};
      const stop=path.join(root,'STOP');
      if(observed.allowed){
        const result=await executeCoreConsoleNative('probe',{},stop,new AbortController().signal);
        const receipt=result.data as {guardVerified:boolean;effectAttempted:boolean};
        assert.equal(receipt.guardVerified,true);assert.equal(receipt.effectAttempted,false);
      }else await assert.rejects(executeCoreConsoleNative('probe',{},stop,new AbortController().signal));
      await fs.writeFile(stop,'STOP');
      await assert.rejects(executeCoreConsoleNative('probe',{},stop,new AbortController().signal));
      await fs.rm(stop);await fs.writeFile(stop+'.blocked','BLOCKED');
      await assert.rejects(executeCoreConsoleNative('probe',{},stop,new AbortController().signal));
      // Probe never injects input, changes foreground or switches a desktop.
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });

test('real Windows DPAPI enrollment survives reload and rejects modified ciphertext',
  {skip:process.platform!=='win32'},async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-core-dpapi-'));
    try{
      const store=new WindowsCoreProfileStore(root),keys=generateKeyPairSync('ed25519');
      const der=keys.publicKey.export({type:'spki',format:'der'});
      const enrollment={version:1 as const,scope:'physical-console' as const,
        ownerAccountId:'isolated-owner-0001',deviceId:'isolated-device-0001',installationId:randomUUID(),
        enrollmentId:randomUUID(),ownerEpoch:1,grantGeneration:1,revokeEpoch:0,
        approvedLocallyAtMs:Date.now(),issuerSpkiSha256:createHash('sha256').update(der).digest('hex')};
      const profile={version:1 as const,deviceId:enrollment.deviceId,installationId:enrollment.installationId,
        authorityUrl:'https://core.example/api/v1/device/core-console',pendingRevoke:false,
        privateKey:keys.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),
        certificate:{enrollment,signatureBase64:sign(null,canonicalCoreConsoleEnrollment(enrollment),keys.privateKey).toString('base64')}};
      await store.save(profile);assert.deepEqual(await store.load(),profile);
      assert.deepEqual(await new WindowsCoreProfileStore(root).load(),profile,'a fresh process profile requires DPAPI decryption');
      const file=path.join(root,'profile.dpapi.json'),raw=await fs.readFile(file,'utf8');
      assert.equal(raw.includes(profile.privateKey),false);assert.equal(raw.includes(enrollment.ownerAccountId),false);
      const envelope=JSON.parse(raw);const bytes=Buffer.from(envelope.ciphertext,'base64');bytes[bytes.length-1]=(bytes[bytes.length-1]??0)^1;
      envelope.ciphertext=bytes.toString('base64');await fs.writeFile(file,JSON.stringify(envelope));
      await assert.rejects(store.load());
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
