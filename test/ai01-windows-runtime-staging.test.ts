import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script=path.resolve('scripts/Install-Nexowire-SystemHubRuntime.ps1');
const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const target='C:\\Program Files\\Nexowire\\SystemHub';

function invoke(action:string,source:string,sha:string){
  return spawnSync(powershell,[
    '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',script,'-Action',action,'-SourceDirectory',source,
    '-ExpectedTreeSha256',sha,
  ],{encoding:'utf8',windowsHide:true,timeout:30000});
}

test('AI-01 Program Files staging Plan verifies an exact tree digest without changing installed runtime',{
  skip:process.platform!=='win32',
},()=>{
  const fixture=mkdtempSync(path.join(os.tmpdir(),'nexowire-ai01-runtime-'));
  const before=existsSync(target);
  try{
    mkdirSync(path.join(fixture,'dist','src'),{recursive:true});
    mkdirSync(path.join(fixture,'node_modules','tiny'),{recursive:true});
    writeFileSync(path.join(fixture,'package.json'),'{"name":"nexowire"}');
    writeFileSync(path.join(fixture,'package-lock.json'),'{}');
    writeFileSync(path.join(fixture,'dist','src','cli.js'),'// disposable test fixture');
    writeFileSync(path.join(fixture,'node_modules','tiny','index.js'),'export {};');
    const wrong=invoke('Plan',fixture,'0'.repeat(64));
    assert.equal(wrong.status,0,wrong.stderr);
    const first=JSON.parse(wrong.stdout);
    assert.match(first.treeSha256,/^[a-f0-9]{64}$/);
    assert.ok(first.blockers.includes('PINNED_TREE_SHA256_MISMATCH'));
    assert.equal(first.ready,false);
    assert.equal(first.action,'Plan');
    const correct=invoke('Plan',fixture,first.treeSha256);
    assert.equal(correct.status,0,correct.stderr);
    const second=JSON.parse(correct.stdout);
    assert.equal(second.treeSha256,first.treeSha256);
    assert.equal(second.blockers.includes('PINNED_TREE_SHA256_MISMATCH'),false);
    assert.equal(second.blockers.includes('AI01_RUNTIME_FILE_MISSING: dist/src/cli.js'),false);
    assert.equal(second.files,4);
    assert.equal(existsSync(target),before);
    const denied=invoke('Install',fixture,'0'.repeat(64));
    assert.notEqual(denied.status,0);
    assert.match(denied.stderr+denied.stdout,/AI01_INSTALL_PREFLIGHT_BLOCKED/);
    assert.equal(existsSync(target),before);
  }finally{
    rmSync(fixture,{recursive:true,force:true});
  }
});
