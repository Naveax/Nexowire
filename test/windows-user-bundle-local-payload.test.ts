import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {renderSetupScript} from '../scripts/build-windows-user-bundle.js';

const sourceSha='436b84c89454db592257fd549fdc65cbbd036d1e';
const platformWindows=process.platform==='win32';

function runChecksumPreflight(root:string, localContents:Buffer, expectedSha:string){
  const setup=renderSetupScript({
    version:'1.0.8',sourceSha,payloadSha256:expectedSha,repository:'Naveax/Nexowire',
  });
  const command=setup.split(/\r?\n/).find(x=>x.startsWith('powershell.exe '));
  assert.ok(command);
  const start=command.indexOf(' -Command "')+' -Command "'.length;
  assert.ok(start>' -Command "'.length);
  const stop=command.indexOf('  New-Item -ItemType Directory -Force -Path $env:NX_EXTRACT',start);
  assert.ok(stop>start);
  // Exercise only the REAL generated payload-selection and hash-verification
  // prefix. No extraction, Scheduled Task, installation or auto-update runs.
  const isolatedScript=command.slice(start,stop)+"  }; Write-Output 'PINNED_PAYLOAD_OK';";
  const local=path.join(root,'Nexowire-Windows-x64.zip');
  const dest=path.join(root,'temp','Nexowire-Windows-x64.zip');
  mkdirSync(path.dirname(dest),{recursive:true});
  writeFileSync(local,localContents);
  const ps=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',isolatedScript],{
    encoding:'utf8',windowsHide:true,timeout:20_000,
    env:{...process.env,
      NX_LOCAL_ZIP:local,NX_ZIP:dest,
      NX_INSTALL:path.join(root,'does-not-exist'),
      NX_PAYLOAD_SHA256:expectedSha,
      NX_PAYLOAD_URL:'https://127.0.0.1:9/do-not-download',
    },
  });
  return {result,dest};
}

test('same-folder candidate ZIP is hashed and accepted without downloading a stale tag',{
  skip:!platformWindows,
},()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'nwx-local-setup-positive-'));
  try{
    const contents=Buffer.from('disposable pinned payload bytes');
    const sha=createHash('sha256').update(contents).digest('hex');
    const {result,dest}=runChecksumPreflight(root,contents,sha);
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/PINNED_PAYLOAD_OK/);
    assert.deepEqual(readFileSync(dest),contents);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('same-folder tampered ZIP fails closed and never falls back to stale published tag',{
  skip:!platformWindows,
},()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'nwx-local-setup-negative-'));
  try{
    const genuine=Buffer.from('disposable original payload');
    const sha=createHash('sha256').update(genuine).digest('hex');
    const {result,dest}=runChecksumPreflight(root,Buffer.from('modified payload'),sha);
    assert.notEqual(result.status,0);
    assert.match(result.stderr+result.stdout,/Nexowire payload checksum mismatch/);
    assert.deepEqual(readFileSync(dest),Buffer.from('modified payload'));
  }finally{rmSync(root,{recursive:true,force:true});}
});
