import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const script=resolve('scripts/probe-windows-unprivileged-write-access.ps1');
const content=readFileSync(script,'utf8');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const localPs='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

test('P0 effective write probe is non-mutating and never grants cutover',()=>{
  for(const marker of [
    'READ_ONLY_OPEN_EXISTING','OPEN_EXISTING','NON_ELEVATED_USER',
    'NexowireP0CreateFileProbe','CreateFileW','GetLastWin32Error',
    "if($errorCode -eq 5){continue}",
    'ACCESS_PROBE_REQUIRES_UNELEVATED_USER',
    "safeToCutover=$false","authorizedToElevate=$false",
    'taskOrAclChanged=$false','productionBytesChanged=$false',
    'allProbedRightsDenied=',
  ])assert.ok(content.includes(marker),marker);
  assert.doesNotMatch(content,/\bSet-Acl\b|\bicacls(?:\.exe)?\b|\bRegister-ScheduledTask\b|\bStop-ScheduledTask\b/);
  assert.doesNotMatch(content,/\bWriteAllBytes\b|\bWriteAllText\b|\bWriteFile\b|\bFileMode\.(?:Create|Append|Truncate)\b/);
  assert.match(content,/creationDisposition, uint flagsAndAttributes/);
  assert.match(content,/3,\[uint32\]0x02000000/);
  assert.ok(content.includes("Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1'"));
});

test('unprivileged rights probe detects user-write grants without changing file bytes',{
  skip:process.platform!=='win32',
},()=>{
  const root=mkdtempSync(join(tmpdir(),'nx-p0-open-only-'));
  const entry=join(root,'cli.js');
  const value='isolated writable fixture\n';
  writeFileSync(entry,value,'utf8');
  const before=hash(readFileSync(entry,'utf8'));
  try{
    const result=spawnSync(localPs,[
      '-NoProfile','-NonInteractive','-File',script,
      '-RuntimeRoot',root,'-Entrypoint',entry,'-FullTree',
      '-MaxObjects','200','-MaxReportedFindings','3',
    ],{
      encoding:'utf8',shell:false,windowsHide:true,timeout:45000,
      env:{...process.env,PSModulePath:root},
    });
    if(result.status!==0 && (result.stderr+result.stdout).includes('ACCESS_PROBE_REQUIRES_UNELEVATED_USER')){
      // GitHub Windows runners may execute with an Administrator token.
      // Refusal is required: an elevated access check cannot prove denial
      // to an ordinary user. The local non-elevated probe is separately run.
      assert.equal(before,hash(readFileSync(entry,'utf8')));
      return;
    }
    assert.equal(result.status,0,result.stderr+' '+result.stdout);
    const report=JSON.parse(result.stdout);
    assert.equal(report.mode,'READ_ONLY_OPEN_EXISTING');
    assert.equal(report.tokenClass,'NON_ELEVATED_USER');
    assert.equal(report.productionBytesChanged,false);
    assert.equal(report.taskOrAclChanged,false);
    assert.equal(report.authorizedToElevate,false);
    assert.equal(report.safeToCutover,false);
    assert.equal(report.fullTreeAudited,true);
    assert.ok(report.objectCount>=2);
    assert.ok(report.grantedWriteRights>=1);
    assert.ok(report.findings.some((f:{component:string;result:string})=>
      f.component==='@entry'&&f.result==='GRANTED'));
    assert.ok(report.findings.length<=3);
    assert.equal(report.omittedFindings,
      report.grantedWriteRights+report.inconclusiveRights-report.findings.length);
    assert.equal(report.allProbedRightsDenied,false);
    assert.equal(before,hash(readFileSync(entry,'utf8')));
    assert.equal(existsSync(entry),true);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test('scope mismatch, relative input and incomplete inventory fail closed',{
  skip:process.platform!=='win32',
},()=>{
  const root=mkdtempSync(join(tmpdir(),'nx-p0-invalid-'));
  const entry=join(root,'entry.js');
  writeFileSync(entry,'test');
  try{
    for(const args of [
      ['-RuntimeRoot',root,'-Entrypoint',localPs],
      ['-RuntimeRoot','relative\\path','-Entrypoint',entry],
      ['-RuntimeRoot',root,'-Entrypoint',entry,'-MaxObjects','2'],
    ]){
      const run=spawnSync(localPs,['-NoProfile','-NonInteractive','-File',script,...args],{
        encoding:'utf8',shell:false,windowsHide:true,timeout:30000,
      });
      assert.notEqual(run.status,0,'Unexpected complete scan: '+run.stdout);
      assert.ok(!run.stdout.includes('"allProbedRightsDenied":true'));
    }
  }finally{rmSync(root,{recursive:true,force:true})}
});
