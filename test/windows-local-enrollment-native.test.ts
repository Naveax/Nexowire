import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyPersistentEnrollmentSession,persistentEnrollmentBytes,persistentEnrollmentHash,
  type PersistentEnrollmentV2,type PersistentSessionV2} from '../src/protocol/core-persistent-enrollment-v2.js';

test('actual Windows CNG non-exportable diagnostic key interoperates with v2 verifier',{
  skip:process.platform!=='win32',timeout:60000,
},()=>{
  const exe=fileURLToPath(new URL('../native/windows-local-enrollment/bin/qa/Nexowire.LocalEnrollment.exe',import.meta.url));
  const result=spawnSync(exe,['--self-test'],{encoding:'utf8',timeout:45000,maxBuffer:65536,windowsHide:true});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  const f=JSON.parse(result.stdout) as {diagnosticOnly:boolean;privateExportDenied:boolean;spkiBase64:string;
    grant:{payload:PersistentEnrollmentV2;signatureBase64:string};
    session:{payload:PersistentSessionV2;signatureBase64:string}};
  assert.equal(f.diagnosticOnly,true);assert.equal(f.privateExportDenied,true);
  const p=f.grant.payload,s=f.session.payload;
  // Identical canonical bytes are indirectly checked by signatures from CNG;
  // the service's JSON output alone cannot establish a successful verifier.
  assert.ok(persistentEnrollmentBytes(p).includes(Buffer.from('nexowire.local.enrollment.v2\0')));
  assert.equal(s.enrollmentSha256,persistentEnrollmentHash(p));
  const input={grant:f.grant,session:f.session,pinnedSpkiDer:Buffer.from(f.spkiBase64,'base64'),
    nowMs:s.observedAtMs,expected:{ownerAccountId:p.ownerAccountId,ownerSid:p.ownerSid,
      deviceId:p.deviceId,installationId:p.installationId,machineBindingSha256:p.machineBindingSha256,
      enrollmentId:p.enrollmentId,generation:p.generation,revoked:false,nonce:s.nonce,bootId:s.bootId,
      windowsSessionId:s.windowsSessionId,logonLuid:s.logonLuid}};
  assert.equal(verifyPersistentEnrollmentSession(input).mayDispatch,false);
  input.expected.revoked=true;
  assert.throws(()=>verifyPersistentEnrollmentSession(input),/V2_REJECTED/);
  const unsupported=spawnSync(exe,['--enroll','unused','--yes'],{encoding:'utf8',timeout:10000,
    maxBuffer:1024,windowsHide:true});
  assert.ifError(unsupported.error);assert.equal(unsupported.status,2);
  assert.match(unsupported.stderr,/INVALID_COMMAND/);
});
test('actual Windows machine CNG key owner/DACL survive reopen without enrollment',{
  skip:process.platform!=='win32',timeout:60000,
},()=>{
  const exe=fileURLToPath(new URL('../native/windows-local-enrollment/bin/qa/Nexowire.LocalEnrollment.exe',import.meta.url));
  const result=spawnSync(exe,['--machine-key-self-test'],{encoding:'utf8',timeout:45000,maxBuffer:4096,windowsHide:true});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{diagnosticOnly:true,machineKeyAclVerified:true,
    privateExportDenied:true,provider:'software',humanEnrollment:false});
});

test('Windows installer read-only preflight rejects owner and installation identity mismatches',{
  skip:process.platform!=='win32',timeout:60000,
},()=>{
  const sidResult=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
    {encoding:'utf8',timeout:10000,maxBuffer:1024,windowsHide:true});
  assert.ifError(sidResult.error);
  assert.equal(sidResult.status,0,sidResult.stderr);
  const ownerSid=sidResult.stdout.trim();
  assert.match(ownerSid,/^S-1-\d+(?:-\d+)+$/);
  const root=mkdtempSync(join(tmpdir(),'nexowire-ai02-preflight-'));
  try{
    const bundle=join(root,'bundle'),runtime=join(bundle,'runtime');
    mkdirSync(runtime,{recursive:true});
    const fakeExe=Buffer.from('ai02-preflight-fixture-not-executable');
    writeFileSync(join(runtime,'Nexowire.LocalEnrollment.exe'),fakeExe);
    const manifest={version:1,kind:'nexowire-local-enrollment-opt-in',
      source:'a'.repeat(40),sourceTree:'b'.repeat(40),
      files:[{path:'Nexowire.LocalEnrollment.exe',bytes:fakeExe.length,
        sha256:createHash('sha256').update(fakeExe).digest('hex')}]};
    const manifestBytes=Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(bundle,'manifest.json'),manifestBytes);
    const manifestHash=createHash('sha256').update(manifestBytes).digest('hex');
    const deviceId=randomUUID(),otherDeviceId=randomUUID();
    const installationId=randomUUID(),ownerAccountId='owner-account-0001';
    const identityPath=join(root,'agent.json'),requestPath=join(root,'request.json');
    const script=fileURLToPath(new URL('../scripts/local-enrollment/install.ps1',import.meta.url));
    const identity={id:deviceId,installationId,ownerAccountId};
    const request={deviceId,installationId,ownerAccountId,ownerSid,authoritySpkiBase64:'fixture-only'};
    const command="$ErrorActionPreference='Stop'; $ids=[Guid[]]@([Guid]::Parse($env:AI02_DEVICE),[Guid]::Parse($env:AI02_OTHER)); & $env:AI02_SCRIPT -BundleDirectory $env:AI02_BUNDLE -ExpectedManifestSha256 $env:AI02_HASH -EnrollmentRequestFile $env:AI02_REQUEST -AgentIdentityFile $env:AI02_IDENTITY -ExpectedDeviceId ([Guid]::Parse($env:AI02_DEVICE)) -AllowedDeviceIds $ids -PreflightOnly";
    const execute=(id:unknown,req:unknown)=>{
      writeFileSync(identityPath,JSON.stringify(id));
      writeFileSync(requestPath,JSON.stringify(req));
      // Read-only preflight supports PowerShell 7; CI's pwsh environment
      // does not guarantee Windows PowerShell 5.1's module-autoload path.
      return spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',command],{
        encoding:'utf8',timeout:10000,maxBuffer:16384,windowsHide:true,
        env:{...process.env,AI02_DEVICE:deviceId,AI02_OTHER:otherDeviceId,
          AI02_SCRIPT:script,AI02_BUNDLE:bundle,AI02_HASH:manifestHash,
          AI02_REQUEST:requestPath,AI02_IDENTITY:identityPath},
      });
    };
    const ok=execute(identity,request);
    assert.ifError(ok.error);
    assert.equal(ok.status,0,ok.stderr);
    assert.match(ok.stdout,/"installed"\s*:\s*false/);
    for(const [id,req,error] of [
      [identity,{...request,installationId:randomUUID()},'LOCAL_OWNER_DEVICE_MISMATCH'],
      [identity,{...request,ownerAccountId:'other-account-01'},'LOCAL_OWNER_DEVICE_MISMATCH'],
      [{...identity,installationId:''},request,'AGENT_IDENTITY_BINDING_INCOMPLETE'],
      [{id:deviceId,ownerAccountId},request,'AGENT_IDENTITY_BINDING_INCOMPLETE'],
    ] as const){
      const rejected=execute(id,req);
      assert.ifError(rejected.error);
      assert.notEqual(rejected.status,0,rejected.stdout);
      assert.match(rejected.stderr,new RegExp(error));
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Windows opt-in service uninstall defaults to read-only without touching SCM',{
  skip:process.platform!=='win32',timeout:15000,
},()=>{
  // Disposable CI runners have no installed NexowireLocalEnrollment service.
  // This is a no-service preflight, NOT a service stop/delete or physical test.
  const script=fileURLToPath(new URL('../scripts/local-enrollment/uninstall.ps1',import.meta.url));
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script,
    '-ExpectedManifestSha256','9'.repeat(64),'-ExpectedDeviceId',randomUUID()],{
    encoding:'utf8',timeout:10000,maxBuffer:4096,windowsHide:true,
  });
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout) as {servicePresent:boolean;changed:boolean;
    protectedStatePreserved:boolean;runtimePreserved:boolean};
  assert.equal(report.servicePresent,false);
  assert.equal(report.changed,false);
  assert.equal(report.protectedStatePreserved,true);
  assert.equal(report.runtimePreserved,true);
});
