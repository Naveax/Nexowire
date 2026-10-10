import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {renderMachineCutoverScript} from '../src/update/machine-update.js';

const old='C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef';
const newer='C:\\ProgramData\\Nexowire\\versions\\1.0.6-012345abcdef';
const alternate='C:\\ProgramData\\Nexowire\\versions\\1.0.4-012345abcdef';
const script=renderMachineCutoverScript({
  version:'1.0.6',buildId:'1.0.6-012345abcdef',targetRoot:newer,
});
const lines=script.split(/\r?\n/);
const start=lines.findIndex(s=>s.startsWith('function Patch-Launcher('));
const end=lines.indexOf('}',start+1);
assert.ok(start>=0 && end>start,'expected standalone launcher patcher');
const fn=lines.slice(start,end+1).join('\r\n');

const hub=(root:string)=>[
  "$ErrorActionPreference='Stop'",
  '$process=Start-Process -FilePath '+"'"+root+"\\runtime\\node.exe'"+
    ' -ArgumentList '+ "@('"+root+"\\app\\dist\\src\\cli.js','http')"+
    ' -PassThru',
  '$process.WaitForExit()',
].join('\r\n');
const broker=(root:string)=>[
  "$ErrorActionPreference='Stop'",
  "& '"+root+"\\runtime\\node.exe' '"+root+"\\app\\dist\\src\\cli.js' 'privileged-broker' 'run'",
  'exit $LASTEXITCODE',
].join('\r\n');

function invoke(content:string){
  const dir=mkdtempSync(path.join(tmpdir(),'nx-launcher-guard-'));
  const file=path.join(dir,'launch.ps1');
  const backup=file+'.update-rollback';
  try{
    writeFileSync(file,content,'utf8');
    const fixture=[
      "$ErrorActionPreference='Stop'",
      '$NewRoot='+"'"+newer+"'",
      '$backups=@{}',
      '$file='+("'"+file.replaceAll("'","''")+"'"),
      fn,
      "try { Patch-Launcher $file; [Console]::WriteLine('PASS') }",
      "catch { [Console]::WriteLine('BLOCK:'+([string]$_.Exception.Message)) }",
    ].join('\r\n');
    const proc=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
        Buffer.from(fixture,'utf16le').toString('base64')],{
        cwd:'C:\\Windows\\System32',
        env:{
          SystemRoot:'C:\\Windows',windir:'C:\\Windows',
          PATH:'C:\\Windows\\System32;C:\\Windows',
          PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
        },encoding:'utf8',timeout:10000,maxBuffer:128*1024,windowsHide:true,
      });
    assert.equal(proc.status,0,proc.stderr);
    return {status:proc.stdout.trim(),content:readFileSync(file,'utf8'),
      backed:existsSync(backup),backup:existsSync(backup)?readFileSync(backup,'utf8'):''};
  }finally{rmSync(dir,{recursive:true,force:true});}
}

test('launcher rendering requires a unique, fully linked versioned executable and CLI',()=>{
  assert.match(script,/MACHINE_UPDATE_LAUNCHER_ROOT_AMBIGUOUS/);
  assert.match(script,/MACHINE_UPDATE_LAUNCHER_EXECUTABLE_MISMATCH/);
  assert.match(script,/MACHINE_UPDATE_LAUNCHER_ROOT_UNTRUSTED/);
  assert.match(script,/MACHINE_UPDATE_LAUNCHER_TOO_LARGE/);
  assert.doesNotMatch(script,/if\(\$text\.Contains\(\$NewRoot\)\)\{return\}/);
});

for(const [name,launcher] of [['Hub',hub(old)],['Broker',broker(old)]] as const){
  test(name+' launcher is upgraded and backed up only for validated pair',{skip:process.platform!=='win32'},()=>{
    const x=invoke(launcher);
    assert.equal(x.status,'PASS');
    assert.equal(x.backed,true);
    assert.equal(x.backup,launcher);
    assert.ok(x.content.includes(newer+'\\runtime\\node.exe'));
    assert.ok(x.content.includes(newer+'\\app\\dist\\src\\cli.js'));
    assert.ok(!x.content.includes(old+'\\runtime\\node.exe'));
  });
}
test('already upgraded verified runtime does not rewrite/backup launcher',{skip:process.platform!=='win32'},()=>{
  const x=invoke(hub(newer));
  assert.equal(x.status,'PASS');
  assert.equal(x.backed,false);
});
test('new version root in a comment cannot hide an old executable',{skip:process.platform!=='win32'},()=>{
  const content='# '+newer+'\r\n'+hub(old);
  const x=invoke(content);
  assert.match(x.status,/^BLOCK:MACHINE_UPDATE_LAUNCHER_ROOT_AMBIGUOUS$/);
  assert.equal(x.content,content);
  assert.equal(x.backed,false);
});
test('mixed old executable and different CLI root must be rejected',{skip:process.platform!=='win32'},()=>{
  const content=hub(old).replace(old+'\\app\\dist\\src\\cli.js',alternate+'\\app\\dist\\src\\cli.js');
  const x=invoke(content);
  assert.match(x.status,/^BLOCK:MACHINE_UPDATE_LAUNCHER_ROOT_AMBIGUOUS$/);
  assert.equal(x.content,content);
  assert.equal(x.backed,false);
});
test('single version token without expected CLI is rejected',{skip:process.platform!=='win32'},()=>{
  const content=hub(old).replace(old+'\\app\\dist\\src\\cli.js','C:\\Somewhere\\test.js');
  const x=invoke(content);
  assert.equal(x.status,'BLOCK:MACHINE_UPDATE_LAUNCHER_EXECUTABLE_MISMATCH');
  assert.equal(x.backed,false);
});
test('outside ProgramData runtime is rejected',{skip:process.platform!=='win32'},()=>{
  const strange='C:\\Users\\Public\\Nexowire\\versions\\1.0.5-012345abcdef';
  const x=invoke(hub(strange));
  assert.equal(x.status,'BLOCK:MACHINE_UPDATE_LAUNCHER_ROOT_UNTRUSTED');
  assert.equal(x.backed,false);
});
test('oversized launcher is refused before backup or modification',{skip:process.platform!=='win32'},()=>{
  const x=invoke(hub(old)+'\r\n'+('#'.repeat(65537)));
  assert.equal(x.status,'BLOCK:MACHINE_UPDATE_LAUNCHER_TOO_LARGE');
  assert.equal(x.backed,false);
});
