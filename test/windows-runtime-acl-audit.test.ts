import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const script=resolve('scripts/audit-windows-runtime-acl.ps1');
const source=readFileSync(script,'utf8');

test('ACL diagnostic must not mutate Windows permissions, tasks, files or protected tokens',()=>{
  assert.match(source,/mode='READ_ONLY'/);
  assert.match(source,/ownerApprovedElevatedExecution=\$false/);
  assert.match(source,/dependenciesRecursivelyAudited=\$false/);
  for(const unsafe of ['Set-Acl','icacls.exe','takeown.exe','Start-Process',
    'Remove-Item','Copy-Item','Move-Item','New-ScheduledTask','Register-ScheduledTask',
    'Stop-ScheduledTask','Start-ScheduledTask','Import-Clixml',
    'ConvertTo-SecureString','Set-Content','Out-File']){
    assert.equal(source.includes(unsafe),false,unsafe);
  }
});

test('Windows ACL audit recognizes untrusted code path and validates PowerShell syntax',{
  skip:process.platform!=='win32',
},()=>{
  const dir=mkdtempSync(join(tmpdir(),'nexowire-acl-audit-'));
  const entry=join(dir,'cli.js');
  writeFileSync(entry,'// test only\n','utf8');
  try{
    const safePath="'"+script.replaceAll("'","''")+"'";
    const parse=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      '$file='+safePath+';$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile($file,[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|ForEach-Object{$_.Message};exit 5}'],{
        encoding:'utf8',timeout:20000,windowsHide:true
      });
    assert.equal(parse.status,0,parse.stderr+' '+parse.stdout);
    const process=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script,
      '-RuntimeRoot',dir,'-Entrypoint',entry],{encoding:'utf8',timeout:20000,windowsHide:true});
    assert.equal(process.status,0,process.stderr+' '+process.stdout);
    const data=JSON.parse(process.stdout);
    assert.equal(data.mode,'READ_ONLY');
    assert.equal(data.riskyCodePath,true);
    assert.equal(data.ownerApprovedElevatedExecution,false);
    assert.equal(data.dependenciesRecursivelyAudited,false);
    assert.equal(data.productionFilesChanged,false);
    assert.ok(data.componentsAudited>=2);
    assert.ok(data.issues.some((i:{reason:string})=>i.reason==='UNTRUSTED_OWNER'||i.reason==='UNTRUSTED_WRITE_GRANT'));
    const outside=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script,
      '-RuntimeRoot',dir,'-Entrypoint',script],{encoding:'utf8',timeout:20000,windowsHide:true});
    assert.notEqual(outside.status,0,'out of scope entry must fail closed');
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});
