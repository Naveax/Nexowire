import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

const builder=path.join(process.cwd(),'scripts','Build-Nexowire-SystemHubStage.ps1');
const source=readFileSync(builder,'utf8');
const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const windows=process.platform==='win32';
function currentSha():string{
  const run=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  return run.stdout.trim();
}
function invoke(sha:string,output:string,action:'Plan'|'Build'='Plan'){
  return spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive',
    '-ExecutionPolicy','Bypass','-File',builder,
    '-Action',action,'-RepositoryRoot',process.cwd(),
    '-ExpectedCommitSha',sha,'-OutputDirectory',output],{
      encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:128*1024,
    });
}
test('SYSTEM stage builder uses a clean pinned Git archive, not the live worktree',()=>{
  for(const token of [
    'AI01_STAGE_SOURCE_COMMIT_MISMATCH',
    'AI01_STAGE_SOURCE_WORKTREE_DIRTY',
    'AI01_STAGE_OUTPUT_BOUNDARY_UNTRUSTED',
    'AI01_STAGE_REPARSE_POINT',
    'AI01_STAGE_PACKAGED_MANIFEST_MISMATCH',
    'AI01_STAGE_LOCKFILE_CHANGED',
    'AI01_STAGE_TREE_DIGEST_CHANGED',
    'AI01_STAGE_SOURCE_PREFLIGHT_BLOCKED',
    "'archive','--format=zip'",
    "'ci','--omit=dev','--ignore-scripts'",
    'npm.cmd pack --ignore-scripts',
    'installerTargetUntouched=$true',
    "productionInstalled']=$false",
  ])assert.ok(source.includes(token),'Missing staging safety gate: '+token);
  assert.doesNotMatch(source,/Register-ScheduledTask|Unregister-ScheduledTask|Stop-ScheduledTask/);
  const promoted=source.indexOf('Move-Item -LiteralPath $stage -Destination $output');
  const verified=source.indexOf('-SourceDirectory $output -ExpectedTreeSha256 $treeSha',promoted);
  const receipt=source.indexOf("WriteAllText($output+'.provenance.json'",verified);
  assert.ok(promoted>0&&verified>promoted&&receipt>verified,
    'published bytes must pass a second pinned installer Plan before provenance');
  const plan=source.indexOf("if($Action -eq 'Plan'){");
  const create=source.indexOf("New-Item -ItemType Directory -Path $work");
  assert.ok(plan>0&&create>plan,'Plan must exit before creating staging files');
});

test('PowerShell 5.1 parses stage builder without executing it',{
  skip:!windows,
},()=>{
  const script=[
    '$t=$null;$e=$null',
    "[void][System.Management.Automation.Language.Parser]::ParseFile('"+
      builder.replaceAll("'","''")+"',[ref]$t,[ref]$e)",
    'if(@($e).Count -gt 0){$e|ForEach-Object{$_.Message};exit 5}',
  ].join(';');
  const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',script],{
    encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stderr+' '+result.stdout);
});

test('Plan on clean SHA is read-only and explicitly never installs',{
  skip:!windows,
},()=>{
  const sha=currentSha();
  const output=path.join(process.env.USERPROFILE??'',
    'Documents','Nexowire-SystemHub-Stage-'+sha.slice(0,8)+randomBytes(4).toString('hex'));
  const result=invoke(sha,output);
  assert.equal(result.status,0,result.stderr+' '+result.stdout);
  const plan=JSON.parse(result.stdout);
  assert.equal(plan.action,'Plan');
  assert.equal(plan.sourceCommit,sha);
  assert.equal(plan.sourceClean,true);
  assert.equal(plan.readyForBuild,true);
  assert.equal(plan.installerTargetUntouched,true);
  assert.equal(existsSync(output),false);
});

test('Plan rejects a different source SHA and cannot create output',{
  skip:!windows,
},()=>{
  const sha=currentSha();
  const wrong=sha==='0'.repeat(40)?'1'.repeat(40):'0'.repeat(40);
  const output=path.join(process.env.USERPROFILE??'',
    'Documents','Nexowire-SystemHub-Stage-'+randomBytes(8).toString('hex'));
  const result=invoke(wrong,output);
  assert.notEqual(result.status,0);
  assert.match(result.stdout+result.stderr,/AI01_STAGE_SOURCE_COMMIT_MISMATCH/);
  assert.equal(existsSync(output),false);
});

test('Plan rejects unsafe output paths under the live runtime',{
  skip:!windows,
},()=>{
  const sha=currentSha();
  const output=path.join(process.env.USERPROFILE??'',
    '.nexowire','hub','Nexowire-SystemHub-Stage-'+randomBytes(8).toString('hex'));
  const result=invoke(sha,output);
  assert.notEqual(result.status,0);
  assert.match(result.stdout+result.stderr,/AI01_STAGE_OUTPUT_BOUNDARY_UNTRUSTED/);
  assert.equal(existsSync(output),false);
});