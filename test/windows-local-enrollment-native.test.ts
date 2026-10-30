import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
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
