import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scriptPath=path.resolve('scripts/Build-Nexowire-TransferFlushArtifact.ps1');
const script=readFileSync(scriptPath,'utf8');
const source=readFileSync('native/windows-transfer-volume-flush.cs');

test('AI-05 offline helper build binds the independently reviewed source blob and compiler pins',()=>{
  const blob=createHash('sha1').update('blob '+source.length+'\0').update(source).digest('hex');
  assert.ok(script.includes("$reviewedSourceBlob='"+blob+"'"));
  assert.match(script,/AI05_TRANSFER_SOURCE_HASH_MISMATCH/);
  assert.match(script,/AI05_TRANSFER_SOURCE_REVIEW_REQUIRED/);
  assert.match(script,/Assert-SignedArtifact \$compiler \$ExpectedCompilerSha256 \$ExpectedCompilerSignerSha256/);
  assert.match(script,/'\/platform:x64'/);
  assert.match(script,/ExpectedReferenceSha256/);
  assert.match(script,/AI05_TRANSFER_REFERENCE_HASH_MISMATCH/);
  assert.match(script,/Microsoft\.PowerShell\.Security\\Get-AuthenticodeSignature/);
  assert.match(script,/UNSIGNED_BUILD_ONLY/);
  assert.match(script,/productionEligible=\$false/);
  assert.doesNotMatch(script,/Set-AuthenticodeSignature|Register-ScheduledTask|Start-Process|Set-Acl|New-SelfSignedCertificate/);
});
test('AI-05 signed artifact verification requires exact hash before Authenticode and certificate pin',()=>{
  const start=script.indexOf('function Assert-SignedArtifact');
  const end=script.indexOf('if($VerifySigned)',start);
  assert.ok(start>=0&&end>start);
  const body=script.slice(start,end);
  assert.ok(body.indexOf('AI05_TRANSFER_ARTIFACT_HASH_MISMATCH')<body.indexOf('Get-AuthenticodeSignature'));
  assert.match(body,/Status -ne 'Valid'/);
  assert.match(body,/AI05_TRANSFER_SIGNER_PIN_MISMATCH/);
  assert.match(body,/AI05_TRANSFER_ARTIFACT_CHANGED/);
  assert.match(script,/protectedAclVerified=\$false/);
});
test('AI-05 native signed artifact gate rejects wrong hash and unsigned bytes without modification',{
  skip:process.platform!=='win32',
},()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'nw-ai05-signature-'));
  try{
    const artifact=path.join(root,'windows-transfer-volume-flush.exe');
    const bytes=Buffer.from('synthetic unsigned invalid executable');
    writeFileSync(artifact,bytes);
    const hash=createHash('sha256').update(bytes).digest('hex');
    const ps=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    for(const [expected,reason] of [['0'.repeat(64),'AI05_TRANSFER_ARTIFACT_HASH_MISMATCH'],[hash,'AI05_TRANSFER_AUTHENTICODE_INVALID']]){
      const run=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-File',scriptPath,
        '-VerifySigned','-ArtifactPath',artifact,'-ExpectedArtifactSha256',expected!,
        '-ExpectedArtifactSignerSha256','0'.repeat(64)],{encoding:'utf8',windowsHide:true,timeout:30000});
      assert.equal(run.error,undefined);
      assert.equal(typeof run.status,'number');
      assert.notEqual(run.status,0);
      assert.match(run.stderr+run.stdout,new RegExp(reason!));
      assert.deepEqual(readFileSync(artifact),bytes);
    }
  }finally{rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
