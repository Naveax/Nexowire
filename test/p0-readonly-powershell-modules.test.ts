import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const SYSTEM_MODULES='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
const required:Record<string,string[]>={
  'audit-windows-runtime-acl.ps1':['Microsoft.PowerShell.Security','Microsoft.PowerShell.Management'],
  'inspect-legacy-cutover-readiness.ps1':['Microsoft.PowerShell.Security','ScheduledTasks','NetTCPIP'],
  'backup-legacy-scheduled-task.ps1':['Microsoft.PowerShell.Security','ScheduledTasks'],
};
test('P0 Windows helper scripts pin inbox module lookup before any inspection',()=>{
  for(const [name,modules] of Object.entries(required)){
    const content=readFileSync(path.resolve('scripts',name),'utf8');
    const pin="$env:PSModulePath='"+SYSTEM_MODULES+"'";
    const index=content.indexOf(pin);
    const errorPreference=content.indexOf("$ErrorActionPreference='Stop'");
    assert.ok(errorPreference>=0&&index>errorPreference, name);
    for(const mod of modules){
      const expected="Import-Module -Name '"+SYSTEM_MODULES+"\\"+mod+"\\"+mod+".psd1' -ErrorAction Stop";
      assert.ok(content.includes(expected),name+': '+mod);
      assert.ok(content.indexOf(expected)>index,name+': order');
    }
    assert.ok(!content.includes("Import-Module -Name $env:"),name);
    assert.ok(!content.includes("Set-Acl"),name);
    assert.ok(!content.includes("Register-ScheduledTask"),name);
    assert.ok(!content.includes("Start-ScheduledTask"),name);
    assert.ok(!content.includes("Stop-ScheduledTask"),name);
  }
});
test('read-only ACL audit continues with caller-controlled module search path',{
  skip:process.platform!=='win32',
},()=>{
  const root=mkdtempSync(path.join(tmpdir(),'nexowire-inbox-modules-'));
  const entry=path.join(root,'cli.js');
  writeFileSync(entry,'// test fixture only\n','utf8');
  const script=path.resolve('scripts/audit-windows-runtime-acl.ps1');
  try{
    const result=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-File',script,
      '-RuntimeRoot',root,'-Entrypoint',entry,
    ],{
      encoding:'utf8',windowsHide:true,shell:false,timeout:30000,
      env:{...process.env,PSModulePath:path.join(root,'untrusted-user-modules')},
    });
    assert.equal(result.status,0,result.stderr+' '+result.stdout);
    const response=JSON.parse(result.stdout);
    assert.equal(response.mode,'READ_ONLY');
    assert.equal(response.productionFilesChanged,false);
    assert.equal(response.ownerApprovedElevatedExecution,false);
    assert.ok(response.componentsAudited>=2);
  }finally{
    rmSync(root,{recursive:true,force:true});
  }
});
