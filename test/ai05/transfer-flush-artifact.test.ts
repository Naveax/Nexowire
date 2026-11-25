import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
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
  // Hosted TEMP may use an 8.3 alias (runner~1). Supply the real path;
  // the production gate must continue to reject noncanonical aliases.
  const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'nw-ai05-signature-'));
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

test('hosted Windows compiles reviewed C# helper without signing or executing it',{
  skip:process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted',
  timeout:240000,
},()=>{
  // These pins are observed from the disposable fixture host, NOT independently
  // approved release pins. This proves the build path only.
  const win=process.env.SystemRoot??'C:\\Windows';
  const ps=path.join(win,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const compiler=path.join(win,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  const reference=path.join(path.dirname(compiler),'mscorlib.dll');
  const q=(v:string)=>"'"+v.replaceAll("'","''")+"'";
  const probe=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',[
    "$ErrorActionPreference='Stop'",
    "$env:PSModulePath="+q(path.join(win,'System32','WindowsPowerShell','v1.0','Modules')),
    "Import-Module -Name "+q(path.join(win,'System32','WindowsPowerShell','v1.0','Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1'))+" -ErrorAction Stop",
    "$s=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath "+q(compiler),
    "if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate){throw 'FIXTURE_COMPILER_UNSIGNED'}",
    "$h=[Security.Cryptography.SHA256]::Create()",
    "try{[BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}",
  ].join('; ')],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(probe.error,undefined);assert.equal(probe.status,0,probe.stderr);
  const signer=probe.stdout.trim();assert.match(signer,/^[0-9a-f]{64}$/);
  const hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
  const sourcePath=path.resolve('native/windows-transfer-volume-flush.cs');
  // Positive signature gate on a known signed OS compiler, not a signed
  // Nexowire helper. Wrong certificate pin must deny with the same binary.
  const compilerHash=hash(readFileSync(compiler));
  const verifyArgs=['-NoLogo','-NoProfile','-NonInteractive','-File',scriptPath,
    '-VerifySigned','-ArtifactPath',compiler,'-ExpectedArtifactSha256',compilerHash];
  const verified=spawnSync(ps,[...verifyArgs,'-ExpectedArtifactSignerSha256',signer],
    {encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(verified.error,undefined);assert.equal(verified.status,0,verified.stderr+verified.stdout);
  const signatureReceipt=JSON.parse(verified.stdout.trim());
  assert.equal(signatureReceipt.status,'SIGNED_ARTIFACT_VERIFIED_NOT_INSTALLED');
  assert.equal(signatureReceipt.sha256,compilerHash);
  assert.equal(signatureReceipt.signerSha256,signer);
  assert.equal(signatureReceipt.installed,false);
  const wrong=spawnSync(ps,[...verifyArgs,'-ExpectedArtifactSignerSha256',signer==='0'.repeat(64)?'1'.repeat(64):'0'.repeat(64)],
    {encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(wrong.error,undefined);assert.equal(typeof wrong.status,'number');
  assert.notEqual(wrong.status,0);assert.match(wrong.stderr+wrong.stdout,/AI05_TRANSFER_SIGNER_PIN_MISMATCH/);
  assert.equal(hash(readFileSync(compiler)),compilerHash);
  const args=['-NoLogo','-NoProfile','-NonInteractive','-File',scriptPath,
    '-BuildUnsigned','-SourcePath',sourcePath,'-ExpectedSourceSha256',hash(source),
    '-ExpectedCompilerSha256',hash(readFileSync(compiler)),'-ExpectedCompilerSignerSha256',signer,
    '-ExpectedReferenceSha256',hash(readFileSync(reference))];
  const result=spawnSync(ps,args,{encoding:'utf8',windowsHide:true,timeout:120000});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr+result.stdout);
  const receipt=JSON.parse(result.stdout.trim()) as {artifactPath:string;sha256:string;status:string;sourceGitBlob:string;installed:boolean;executed:boolean;productionEligible:boolean};
  const folder=path.dirname(receipt.artifactPath);
  assert.equal(path.dirname(folder).toLowerCase(),realpathSync.native(os.tmpdir()).toLowerCase());
  assert.equal(realpathSync.native(folder).toLowerCase(),folder.toLowerCase());
  assert.match(path.basename(folder),/^Nexowire-TransferFlush-Build-[0-9a-f]{32}$/);
  assert.equal(path.basename(receipt.artifactPath),'windows-transfer-volume-flush.exe');
  try{
    const bytes=readFileSync(receipt.artifactPath);
    assert.equal(receipt.status,'UNSIGNED_BUILD_ONLY');
    assert.equal(receipt.sha256,hash(bytes));
    assert.equal(receipt.sourceGitBlob,createHash('sha1').update('blob '+source.length+'\0').update(source).digest('hex'));
    assert.equal(receipt.installed,false);assert.equal(receipt.executed,false);assert.equal(receipt.productionEligible,false);
    assert.equal(bytes.readUInt16LE(0),0x5a4d);
    const pe=bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt32LE(pe),0x4550);
    assert.equal(bytes.readUInt16LE(pe+4),0x8664,'x64 PE machine required');
  }finally{rmSync(folder,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
