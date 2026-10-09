import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {renderBoundedWindowsArchiveExtraction} from '../src/update/machine-update.js';

const isWindows=process.platform==='win32';
const binary='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const env={
  SystemRoot:'C:\\Windows',windir:'C:\\Windows',
  PATH:'C:\\Windows\\System32;C:\\Windows',
  PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
};
function psQuote(s:string){return "'"+s.replaceAll("'","''")+"'";}
function invoke(script:string){
  const result=spawnSync(binary,[
    '-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(script,'utf16le').toString('base64'),
  ],{cwd:'C:\\Windows\\System32',env,encoding:'utf8',timeout:25_000,maxBuffer:128*1024});
  return result;
}
function fixture(names:string[],mutate?:(zip:string)=>void){
  const root=mkdtempSync(path.join(tmpdir(),'nx-zip-preflight-'));
  const zip=path.join(root,'asset.zip');
  const extract=path.join(root,'extract');
  mkdirSync(extract);
  const cmd=[
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.IO.Compression',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$archive=[IO.Compression.ZipFile]::Open('+psQuote(zip)+',[IO.Compression.ZipArchiveMode]::Create)',
    'try {',
    ...names.flatMap(name=>[
      '  $entry=$archive.CreateEntry('+psQuote(name)+')',
      '  $writer=[IO.StreamWriter]::new($entry.Open())',
      "  $writer.Write('test')",
      '  $writer.Dispose()',
    ]),
    '} finally { $archive.Dispose() }',
  ].join('\r\n');
  const created=invoke(cmd);
  assert.equal(created.status,0,created.stderr);
  mutate?.(zip);
  return {root,zip,extract};
}
function withFixture(
  names:string[],
  check:(f:{root:string;zip:string;extract:string})=>void,
  mutate?:(zip:string)=>void,
){
  const f=fixture(names,mutate);
  try{check(f);}finally{rmSync(f.root,{recursive:true,force:true});}
}
function rewriteCentral(zip:string,mutate:(b:Buffer,offset:number)=>void){
  const data=readFileSync(zip);
  const sig=Buffer.from([0x50,0x4b,0x01,0x02]);
  let cursor=0;
  while((cursor=data.indexOf(sig,cursor))>=0){
    mutate(data,cursor);
    cursor+=46;
  }
  writeFileSync(zip,data);
}
test('generated extraction script includes count, byte, path and symlink bounds',()=>{
  const script=renderBoundedWindowsArchiveExtraction('C:\\test.zip','C:\\out');
  assert.match(script,/maxEntries=25000/);
  assert.match(script,/maxEntryBytes=\[long\]\(128MB\)/);
  assert.match(script,/maxTotalBytes=\[long\]\(1024MB\)/);
  assert.match(script,/MACHINE_UPDATE_ARCHIVE_UNSAFE_ENTRY/);
  assert.match(script,/MACHINE_UPDATE_ARCHIVE_SYMLINK/);
  assert.ok(script.indexOf('foreach($entry')<script.indexOf('ExtractToDirectory'));
});
test('normal small ZIP extracts inside requested test directory',{
  skip:!isWindows,
},()=>withFixture(['Nexowire/safe.txt'],f=>{
  const result=invoke(renderBoundedWindowsArchiveExtraction(f.zip,f.extract));
  assert.equal(result.status,0,result.stderr);
  assert.equal(readFileSync(path.join(f.extract,'Nexowire','safe.txt'),'utf8'),'test');
}));
test('Windows case-insensitive duplicate extraction paths are refused before writing',{
  skip:!isWindows,
},()=>withFixture(['Nexowire/data.txt','nexowire/DATA.TXT'],f=>{
  const result=invoke(renderBoundedWindowsArchiveExtraction(f.zip,f.extract));
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/MACHINE_UPDATE_ARCHIVE_DUPLICATE_TARGET/);
  assert.equal(existsSync(path.join(f.extract,'Nexowire','data.txt')),false);
}));
test('Windows reserved device names are refused before extraction',{
  skip:!isWindows,
},()=>withFixture(['Nexowire/CON.txt'],f=>{
  const result=invoke(renderBoundedWindowsArchiveExtraction(f.zip,f.extract));
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/MACHINE_UPDATE_ARCHIVE_WINDOWS_PATH_ALIAS/);
}));
test('Windows trailing-dot name alias is refused before extraction',{
  skip:!isWindows,
},()=>withFixture(['Nexowire/unsafe.'],f=>{
  const result=invoke(renderBoundedWindowsArchiveExtraction(f.zip,f.extract));
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/MACHINE_UPDATE_ARCHIVE_WINDOWS_PATH_ALIAS/);
}));
test('ZIP traversal entry is rejected before extraction',{
  skip:!isWindows,
},()=>withFixture(['../outside.txt'],f=>{
  const result=invoke(renderBoundedWindowsArchiveExtraction(f.zip,f.extract));
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/MACHINE_UPDATE_ARCHIVE_UNSAFE_ENTRY|MACHINE_UPDATE_ARCHIVE_ESCAPE/);
  assert.equal(existsSync(path.join(f.root,'outside.txt')),false);
}));
test('ZIP absolute drive path is rejected before extraction',{
  skip:!isWindows,
},()=>withFixture(['C:/Windows/illegal.txt'],f=>{
  const result=invoke(renderBoundedWindowsArchiveExtraction(f.zip,f.extract));
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/MACHINE_UPDATE_ARCHIVE_UNSAFE_ENTRY/);
}));
test('forged ZIP metadata above 128 MiB entry cap is refused',{
  skip:!isWindows,
},()=>withFixture(['Nexowire/large.txt'],f=>{
  const result=invoke(renderBoundedWindowsArchiveExtraction(f.zip,f.extract));
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/MACHINE_UPDATE_ARCHIVE_ENTRY_TOO_LARGE/);
},zip=>rewriteCentral(zip,(data,offset)=>data.writeUInt32LE(129*1024*1024,offset+24))));
test('forged metadata totaling more than 1 GiB is refused',{
  skip:!isWindows,
},()=>withFixture(Array.from({length:9},(_,i)=>'Nexowire/'+i+'.txt'),f=>{
  const result=invoke(renderBoundedWindowsArchiveExtraction(f.zip,f.extract));
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/MACHINE_UPDATE_ARCHIVE_TOTAL_TOO_LARGE/);
},zip=>rewriteCentral(zip,(data,offset)=>data.writeUInt32LE(128*1024*1024,offset+24))));
test('unix symlink entry is rejected from ZIP metadata',{
  skip:!isWindows,
},()=>withFixture(['Nexowire/link'],f=>{
  const result=invoke(renderBoundedWindowsArchiveExtraction(f.zip,f.extract));
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/MACHINE_UPDATE_ARCHIVE_SYMLINK/);
},zip=>rewriteCentral(zip,(data,offset)=>data.writeUInt32LE(0xa0000000,offset+38))));
