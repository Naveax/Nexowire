import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const script=path.resolve('scripts/ai03-system-dpapi-acceptance.ps1');
const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const nonce='73ab90cf'.repeat(8);
const fixture='synthetic-AI03-credential-not-production-'+('x'.repeat(36));
function run(args: string[]) {
  return spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',script,...args],{
    encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:256*1024
  });
}

test('read-only AI-03 script demands real SYSTEM SID, private ciphertext ACL and no token output',()=>{
  const source=readFileSync(script,'utf8');
  for(const marker of [
    "S-1-5-18", 'AI03_SYSTEM_IDENTITY_REQUIRED',
    "windows-dpapi-local-machine", "windows-dpapi-current-user",
    'AI03_MACHINE_SECRET_READ_ACL_UNTRUSTED','AI03_PROTECTED_ANCESTOR_REPLACEABLE',
    'AI03_REPARSE_POINT_DENIED','AI03_SYSTEM_SOURCE_OVERRIDE_DENIED',
    'HMACSHA256','proofSha256'
  ]) {
    assert.ok(source.includes(marker),marker);
  }
  for(const mutation of [
    'Register-ScheduledTask','Start-ScheduledTask','Stop-ScheduledTask',
    'Unregister-ScheduledTask','Set-ScheduledTask','Set-Acl',
    'icacls.exe','Start-Process','Set-Content'
  ]) {
    assert.equal(source.includes(mutation),false,mutation);
  }
  assert.ok(source.includes('secretContentEmitted=$false'));
  assert.ok(source.includes('physicalRebootAccepted=$false'));
  assert.ok(source.includes('brokerEffectAccepted=$false'));
});

test('PowerShell 5.1 parser accepts read-only attestation', {skip:process.platform!=='win32'},()=>{
  const safe=script.replaceAll("'","''");
  const probe="$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('"+
    safe+"',[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|ForEach-Object{$_.Message};exit 11}";
  const r=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',probe],{
    encoding:'utf8',windowsHide:true,timeout:20000
  });
  assert.equal(r.status,0,(r.stderr+r.stdout).slice(0,700));
});

test('ordinary user cannot attest machine secret or override SYSTEM file', {
  skip:process.platform!=='win32'
},()=>{
  const sid=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',
    '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{encoding:'utf8'});
  if(sid.stdout.trim()==='S-1-5-18') return;
  const r=run(['-Mode','System','-Nonce',nonce]);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/AI03_SYSTEM_IDENTITY_REQUIRED/);
  assert.doesNotMatch(r.stderr+r.stdout,/ciphertext|nwx1\.|synthetic-AI03|password/i);
  const overridden=run(['-Mode','System','-Nonce',nonce,'-SourceFile','C:\\Users\\Fake\\token']);
  assert.notEqual(overridden.status,0);
});

test('synthetic CurrentUser DPAPI challenge HMAC is repeatable, secret-free, scope-fenced', {
  skip:process.platform!=='win32'
},()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'nexowire-ai03-dpapi-'));
  try {
    const file=path.join(dir,'source.dpapi.json');
    const escaped=file.replaceAll("'","''");
    const synthetic=fixture.replaceAll("'","''");
    const generator=[
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Security',
      "$s=[Text.Encoding]::UTF8.GetBytes('"+synthetic+"')",
      "$ent=[Text.Encoding]::UTF8.GetBytes('Nexowire/protected-secret/v1/control-plane-service-token')",
      '$c=[Security.Cryptography.ProtectedData]::Protect($s,$ent,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
      "$e=@{version=1;protection='windows-dpapi-current-user';purpose='control-plane-service-token';ciphertext=[Convert]::ToBase64String($c)}",
      "$json=$e|ConvertTo-Json;[IO.File]::WriteAllText('"+escaped+"',$json)",
    ];
    const make=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',generator.join(';')],{
      encoding:'utf8',windowsHide:true,timeout:25000
    });
    assert.equal(make.status,0,(make.stderr+make.stdout).slice(0,1000));
    const first=run(['-Mode','Source','-Nonce',nonce,'-SourceFile',file]);
    assert.equal(first.status,0,(first.stderr+first.stdout).slice(0,1000));
    const parsed=JSON.parse(first.stdout.trim()) as {proofSha256:string;secretContentEmitted:boolean;scopeVerified:boolean;mode:string};
    assert.match(parsed.proofSha256,/^[a-f0-9]{64}$/);
    assert.equal(parsed.secretContentEmitted,false);
    assert.equal(parsed.scopeVerified,true);
    assert.equal(parsed.mode,'Source');
    assert.doesNotMatch(first.stdout+first.stderr,new RegExp(fixture));
    const second=run(['-Mode','Source','-Nonce',nonce,'-SourceFile',file]);
    assert.equal(second.status,0);
    assert.equal(JSON.parse(second.stdout).proofSha256,parsed.proofSha256);
    const differentNonce=run(['-Mode','Source','-Nonce','21'.repeat(32),'-SourceFile',file]);
    assert.equal(differentNonce.status,0);
    assert.notEqual(JSON.parse(differentNonce.stdout).proofSha256,parsed.proofSha256);
    const invalid=run(['-Mode','Source','-Nonce','bad','-SourceFile',file]);
    assert.notEqual(invalid.status,0);
    const wrongScope=JSON.parse(readFileSync(file,'utf8')) as Record<string,unknown>;
    wrongScope.protection='windows-dpapi-local-machine';
    writeFileSync(file,JSON.stringify(wrongScope));
    const denied=run(['-Mode','Source','-Nonce',nonce,'-SourceFile',file]);
    assert.notEqual(denied.status,0);
    assert.match(denied.stderr,/AI03_DPAPI_ENVELOPE_SCOPE_OR_PURPOSE_INVALID/);
    assert.doesNotMatch(denied.stdout+denied.stderr,new RegExp(fixture));
  } finally {rmSync(dir,{recursive:true,force:true})}
});
