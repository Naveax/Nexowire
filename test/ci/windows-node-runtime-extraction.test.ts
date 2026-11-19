import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {nodeRuntimeExtractionPowerShell} from '../../scripts/build-windows-user-bundle.js';

const script=readFileSync(fileURLToPath(new URL('../../scripts/build-windows-user-bundle.ts',import.meta.url)),'utf8');
const ps=(value:string)=>"'" + value.replaceAll("'","''") + "'";

test('Node runtime ZIP must be hashed before Windows PowerShell extraction',()=>{
  const functionStart=script.indexOf('async function downloadNodeRuntime(');
  const functionEnd=script.indexOf('// Verify BEFORE reading built outputs',functionStart);
  assert.ok(functionStart>0&&functionEnd>functionStart);
  const body=script.slice(functionStart,functionEnd);
  const archiveHash=body.indexOf('const actual = await sha256File(archive);');
  const verified=body.indexOf("assert.equal(\n    actual,\n    expected,\n    'Official Node runtime archive checksum mismatch.',");
  const unzip=body.indexOf('runPowerShell(nodeRuntimeExtractionPowerShell(archive, extracted));');
  assert.ok(archiveHash>0&&verified>archiveHash&&unzip>verified,
    'The official archive SHA-256 must be verified before any extraction');
  assert.doesNotMatch(body,/Expand-Archive\s+-LiteralPath/);
});

test('Windows PowerShell extractor pins the two-argument .NET ZIP API and quotes paths',()=>{
  const archive="C:\\Test'temp\\node.zip";
  const dest="C:\\Test'temp\\node-runtime";
  const command=nodeRuntimeExtractionPowerShell(archive,dest);
  assert.match(command,/System\.IO\.Compression\.FileSystem/);
  assert.match(command,/\[System\.IO\.Compression\.ZipFile\]::ExtractToDirectory\(/);
  assert.ok(command.includes(ps(archive)+', '+ps(dest)+')'));
  assert.doesNotMatch(command,/Expand-Archive|ExtractToDirectory\([^)]*,[^)]*,/);
});

test('release workflow executes the native ZIP regression on a Windows runner',()=>{
  const yaml=readFileSync(fileURLToPath(new URL('../../.github/workflows/release-readiness.yml',import.meta.url)),'utf8');
  assert.match(yaml,/Verify native Windows PowerShell 5\.1 ZIP extraction compatibility\n\s+if: runner\.os == 'Windows'\n\s+timeout-minutes: 3\n\s+run: node --test --import tsx test\/ci\/windows-node-runtime-extraction\.test\.ts/);
});

test('real Windows PowerShell 5.1 can extract an isolated disposable ZIP', {
  skip:process.platform!=='win32',
},()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'nexowire-node-zip-'));
  const exe=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  try{
    const input=path.join(dir,'input'),archive=path.join(dir,'node.zip'),output=path.join(dir,'unpacked');
    mkdirSync(input);
    writeFileSync(path.join(input,'LICENSE'),'synthetic local ZIP fixture');
    const makeZip=[
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      '[System.IO.Compression.ZipFile]::CreateFromDirectory('+ps(input)+', '+ps(archive)+')',
    ].join('; ');
    execFileSync(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',makeZip],{
      windowsHide:true,timeout:30000,encoding:'utf8',
    });
    mkdirSync(output);
    const result=spawnSync(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',
      nodeRuntimeExtractionPowerShell(archive,output)],{
      windowsHide:true,encoding:'utf8',timeout:30000,
    });
    assert.equal(result.status,0,result.stderr||result.error?.message);
    assert.equal(readFileSync(path.join(output,'LICENSE'),'utf8'),'synthetic local ZIP fixture');
  }finally{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
