import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
assert.equal(process.platform,'win32');
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
const root=mkdtempSync(path.join(os.tmpdir(),'nx-ai05-ps-probe-'));
const minimal={SystemRoot:'C:\\Windows',windir:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows',
  PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'};
const inherited={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(PATH|PSMODULEPATH|SYSTEMROOT|WINDIR)$/i.test(k))),...minimal};
const q=s=>"'"+s.replaceAll("'","''")+"'";
const shell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
try{
 for(const [name,env,explicit] of [['original-minimal',minimal,false],['profile-inherited',inherited,false],['profile-inherited-inbox',inherited,true]]){
  const log=path.join(root,name+'.log');writeFileSync(log,'',{flag:'wx'});
  const source=[
   "$ErrorActionPreference='Stop'",
   '$phaseLog='+q(log),
   'function Phase([string]$name){[IO.File]::AppendAllText($phaseLog,$name+[Environment]::NewLine)}',
   "Phase 'ENTERED'",
   ...(explicit?["Phase 'IMPORT_BEGIN'","Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1' -ErrorAction Stop","Phase 'IMPORT_END'"]:[]),
   "Phase 'GET_DATE_BEGIN'",
   '$d=Get-Date',
   "Phase 'GET_DATE_END'",
   "Phase 'JSON_BEGIN'",
   '$json=[pscustomobject]@{ok=$true}|ConvertTo-Json -Compress',
   "Phase 'JSON_END'",
   "Phase 'NEW_OBJECT_BEGIN'",
   '$l=New-Object System.Collections.Generic.List[string]',
   "Phase 'NEW_OBJECT_END'",
   '[Console]::WriteLine($json)',
   "Phase 'COMPLETE'",
  ].join('\r\n');
  const started=performance.now();
  const c=spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],
   {cwd:'C:\\Windows\\System32',env,encoding:'utf8',timeout:10000,maxBuffer:128*1024,windowsHide:true});
  const phases=readFileSync(log,'utf8').trim().split(/\r?\n/).filter(Boolean);
  const d={scope:'AI05_HOSTED_PS_ENV_DIFFERENTIAL',case:name,status:c.status,signal:c.signal,errorCode:c.error?.code??null,elapsedMs:Math.round(performance.now()-started),
   phases,profilePresent:Object.keys(env).some(k=>k.toUpperCase()==='USERPROFILE'),tempPresent:Object.keys(env).some(k=>k.toUpperCase()==='TEMP')};
  console.log(JSON.stringify(d));
  // Historical environment probe is diagnostic, not a replacement for any
  // original test. The corrected environment must actually execute all commands.
  if(explicit){
   assert.equal(c.error,undefined,JSON.stringify(d));assert.equal(c.signal,null);assert.equal(c.status,0,JSON.stringify(d));
   assert.equal(phases.at(-1),'COMPLETE');assert.deepEqual(JSON.parse(c.stdout.trim()),{ok:true});
  }
 }
}finally{rmSync(root,{recursive:true,force:true});}
