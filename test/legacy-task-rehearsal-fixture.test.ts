import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script=path.resolve('scripts/backup-legacy-scheduled-task.ps1');
const literal=(value:string):string=>"'"+value.replaceAll("'","''")+"'";
const invoke=(root:string,mode:string,file:string)=>spawnSync('pwsh',[
  '-NoProfile','-NonInteractive','-File',script,
  '-Mode',mode,'-TaskName','Nexowire Stack','-BackupFile',file,
],{encoding:'utf8',timeout:20000,windowsHide:true,env:{...process.env,LOCALAPPDATA:root}});

test('synthetic current-user DPAPI backup verifies and rejects retargeted metadata', {
  skip:process.platform!=='win32',
},()=>{
  // A synthetic XML fixture only: no Windows task is registered or modified.
  const home=process.env.LOCALAPPDATA||os.tmpdir();
  const root=mkdtempSync(path.join(home,'nw-dpapi-rehearsal-'));
  const dir=path.join(root,'Nexowire','recovery');
  const name='legacy-stack-task-synthetic-fixture.dpapi';
  mkdirSync(dir,{recursive:true});
  try{
    const code=[
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Security',
      "$xml='<Task><Actions><Exec><Command>cmd.exe</Command></Exec></Actions></Task>'",
      "$p=[Text.Encoding]::UTF8.GetBytes($xml)",
      "$e=[Text.Encoding]::UTF8.GetBytes('Nexowire.LegacyTask.Recovery.CurrentUser.v1')",
      '$b=[Security.Cryptography.ProtectedData]::Protect($p,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '$sha=[Security.Cryptography.SHA256]::Create()',
      "function Hash([byte[]]$v){return ([BitConverter]::ToString($sha.ComputeHash($v))).Replace('-','').ToLowerInvariant()}",
      '$meta=[ordered]@{schemaVersion=1;taskName="Nexowire Stack";taskPath="\\";'+
       'purpose="Nexowire.LegacyTask.Recovery.CurrentUser.v1";encryption="windows-dpapi-current-user";'+
       'sourceXmlSha256=(Hash $p);encryptedSha256=(Hash $b);encryptedBytes=$b.Length}',
      '[IO.File]::WriteAllBytes('+literal(path.join(dir,name))+',$b)',
      '[IO.File]::WriteAllText('+literal(path.join(dir,name+'.json'))+
       ',($meta|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding $false))',
      '[array]::Clear($p,0,$p.Length)',
      '[array]::Clear($b,0,$b.Length)',
      '$sha.Dispose()',
    ].join(';');
    const seed=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{
      encoding:'utf8',timeout:20000,windowsHide:true,
    });
    assert.equal(seed.status,0,seed.stderr);
    const good=invoke(root,'Verify',name);
    assert.equal(good.status,0,good.stderr);
    const report=JSON.parse(good.stdout);
    assert.equal(report.mode,'VERIFY');
    assert.equal(report.dpapiCurrentUserRoundtrip,true);
    assert.equal(report.activeTaskMatchesBackup,null);
    assert.equal(report.rollbackRestorationTested,false);
    assert.equal(report.safeToCutover,false);
    const manifest=path.join(dir,name+'.json');
    const original=JSON.parse(readFileSync(manifest,'utf8')) as Record<string,unknown>;
    for(const fields of [
      {taskName:'Different Task'},
      {taskPath:'\\Different'},
      {purpose:'Different.Purpose'},
      {encryption:'plaintext'},
      {schemaVersion:2},
    ]){
      writeFileSync(manifest,JSON.stringify({...original,...fields}),'utf8');
      const wrong=invoke(root,'Verify',name);
      assert.notEqual(wrong.status,0);
      assert.match(wrong.stderr,/RECOVERY_MANIFEST_IDENTITY_MISMATCH/);
      assert.doesNotMatch(wrong.stdout,/Task>|Command>|Actions>/i);
    }
    writeFileSync(manifest,JSON.stringify(original),'utf8');
    const invalid=invoke(root,'Rehearse','../'+name);
    assert.notEqual(invalid.status,0);
    assert.doesNotMatch(invalid.stdout,/Task>|Command>|Actions>/i);
  }finally{
    rmSync(root,{recursive:true,force:true});
  }
});
