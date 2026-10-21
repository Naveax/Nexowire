import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  assertNativeProtectedFileBoundary,
  NativeFileBoundaryError,
  type ProtectedRole,
  type VerifiedFilesystemBoundary,
} from '../src/agent/windows-native-file-source-boundary.js';
import {
  syntheticDestination, syntheticProtectedBoundary, syntheticSource,
} from './p05-native-boundary-fixtures.js';

// Independent #26 negatives against the REAL #673 #05 source contract.
// Windows objects only exist below a fresh TEMP root. No OS ACL, user data,
// service, VM, installed Agent or production native code is modified.
const windowsOnly = process.platform !== 'win32' ? 'Windows TEMP kernel32 required' : false;
const KB64 = 64 * 1024;
async function tempRoot(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-w26-p673-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
function denial(expected: string) {
  return (e: unknown) => e instanceof NativeFileBoundaryError && e.code === expected;
}
function verify(w: VerifiedFilesystemBoundary) {
  return assertNativeProtectedFileBoundary(syntheticSource, syntheticDestination,
    'write', 'trusted-owner', 'trusted-device', w);
}
const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";

// Read-attributes-only CreateFileW, with OPEN_REPARSE_POINT and shared delete.
// One PowerShell process retains an NT handle across a disposable junction rename.
// No assertion that this probe attests source ACL or a protected installed DLL.
const nativeProbe = [
  'using System;',
  'using System.ComponentModel;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'using Microsoft.Win32.SafeHandles;',
  'public static class W26P673Probe {',
  ' [StructLayout(LayoutKind.Sequential)] public struct FT { public uint a,b; }',
  ' [StructLayout(LayoutKind.Sequential)] public struct INFO {',
  '  public uint attributes; public FT c,a,w;',
  '  public uint volume,sizeHigh,sizeLow,links,fileHigh,fileLow; }',
  ' [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]',
  ' static extern SafeFileHandle Open(string p,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);',
  ' [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandle",SetLastError=true)]',
  ' static extern bool Get(SafeFileHandle h,out INFO i);',
  ' [DllImport("kernel32.dll",EntryPoint="GetFinalPathNameByHandleW",CharSet=CharSet.Unicode,SetLastError=true)]',
  ' static extern uint Final(SafeFileHandle h,StringBuilder b,uint size,uint flags);',
  ' static SafeFileHandle kept;',
  ' static SafeFileHandle Attr(string p) {',
  '  var h=Open(p,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);',
  '  if(h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error()); return h;',
  ' }',
  ' static string[] Probe(SafeFileHandle h) {',
  '  INFO i; if(!Get(h,out i)) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '  var b=new StringBuilder(32768); uint n=Final(h,b,(uint)b.Capacity,1);',
  '  if(n==0||n>=(uint)b.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '  return new string[]{i.volume.ToString("X8")+":"+i.fileHigh.ToString("X8")+":"+i.fileLow.ToString("X8"),',
  '    b.ToString(),(i.attributes&0x400)!=0?"REPARSE":"REGULAR",i.links.ToString()};',
  ' }',
  ' public static string[] Hold(string p) {kept=Attr(p);return Probe(kept);}',
  ' public static string[] Held() {return Probe(kept);}',
  ' public static string[] Inspect(string p) {using(var h=Attr(p))return Probe(h);}',
  ' public static void Release() {if(kept!=null){kept.Dispose();kept=null;}}',
  '}',
].join('\n');
function ps(commands: string): Record<string, string[]> {
  const script = "$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n" +
    "Add-Type -TypeDefinition @'\n" + nativeProbe + "\n'@\n" + commands +
    '\nConvertTo-Json -InputObject $result -Depth 6 -Compress';
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = execFileSync(exe,
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64')],
    { encoding:'utf8', windowsHide:true, timeout:30000, maxBuffer:128*1024 });
  return JSON.parse(out.trim()) as Record<string, string[]>;
}

test('W26/#673 real NTFS: held no-follow junction handle survives rename, replaced path retargets',
  { skip:windowsOnly, timeout:60000 }, async t => {
    const root=await tempRoot(t);
    const a=path.join(root,'owner-A');
    const b=path.join(root,'owner-B');
    const junction=path.join(root,'approved-link');
    const renamed=path.join(root,'old-link');
    await fs.mkdir(a);
    await fs.mkdir(b);
    await fs.writeFile(path.join(a,'proof.bin'),'A');
    await fs.writeFile(path.join(b,'proof.bin'),'B');
    try {
      await fs.symlink(a,junction,'junction');
    } catch(e) {
      const code=(e as NodeJS.ErrnoException).code;
      if(['EPERM','ENOTSUP','EOPNOTSUPP'].includes(code??'')) {
        t.skip('TEMP junction unavailable: '+code);return;
      }
      throw e;
    }
    const r=ps([
      '$before=[W26P673Probe]::Hold('+psQuote(junction)+')',
      'try {',
      '  [System.IO.Directory]::Move('+psQuote(junction)+','+psQuote(renamed)+')',
      '  New-Item -ItemType Junction -Path '+psQuote(junction)+
        ' -Target '+psQuote(b)+' -ErrorAction Stop | Out-Null',
      '  $held=[W26P673Probe]::Held()',
      '  $new=[W26P673Probe]::Inspect('+psQuote(junction)+')',
      '  $orphan=[W26P673Probe]::Inspect('+psQuote(renamed)+')',
      '  $result=[ordered]@{before=$before;held=$held;replacement=$new;orphan=$orphan}',
      '} finally {[W26P673Probe]::Release()}',
    ].join('\n'));
    assert.equal(r.before?.[2],'REPARSE');
    assert.equal(r.held?.[2],'REPARSE');
    assert.equal(r.replacement?.[2],'REPARSE');
    assert.equal(r.before?.[0],r.held?.[0],'held physical reparse object retains ID');
    assert.equal(r.held?.[0],r.orphan?.[0],'renamed object, not new junction');
    assert.notEqual(r.held?.[0],r.replacement?.[0],'original path now different reparse object');
    assert.notEqual(r.held?.[1]?.toLowerCase(),r.replacement?.[1]?.toLowerCase(),
      'handle final path follows renamed old object, not replacement');
    assert.equal(await fs.readFile(path.join(junction,'proof.bin'),'utf8'),'B');
    assert.equal(await fs.readFile(path.join(renamed,'proof.bin'),'utf8'),'A');
  });

test('W26/#673 real NTFS: hardlink/ADS alias keeps file ID but crosses stream/path grant',
  { skip:windowsOnly, timeout:60000 }, async t=>{
    const root=await tempRoot(t);
    const own=path.join(root,'owner');
    const foreign=path.join(root,'foreign');
    await fs.mkdir(own);await fs.mkdir(foreign);
    const source=path.join(own,'trusted.bin');
    const hardlink=path.join(foreign,'alias.bin');
    const ads=source+':w26_673_stream';
    await fs.writeFile(source,'trusted data');
    await fs.link(source,hardlink);
    await fs.writeFile(ads,'different stream');
    const r=ps([
      '$result=[ordered]@{',
      'original=[W26P673Probe]::Inspect('+psQuote(source)+')',
      'alias=[W26P673Probe]::Inspect('+psQuote(hardlink)+')',
      'ads=[W26P673Probe]::Inspect('+psQuote(ads)+')',
      '}',
    ].join('\n'));
    assert.equal(r.original?.[0],r.alias?.[0]);
    assert.equal(r.original?.[0],r.ads?.[0]);
    assert.ok(Number(r.original?.[3])>=2);
    assert.notEqual(r.original?.[1],r.ads?.[1]);
    const hardlinkWitness=syntheticProtectedBoundary();
    hardlinkWitness.source.linkCount=Number(r.original?.[3]);
    assert.throws(()=>verify(hardlinkWitness),
      denial('FILE_NATIVE_HANDLE_IDENTITY_UNVERIFIED'));
    const alternateStream=syntheticProtectedBoundary();
    alternateStream.source.alternateStream=true;
    assert.throws(()=>verify(alternateStream),
      denial('FILE_NATIVE_HANDLE_IDENTITY_UNVERIFIED'));
    const requestAlias=syntheticProtectedBoundary();
    assert.throws(()=>assertNativeProtectedFileBoundary(
      syntheticSource.replace('file-helper.exe','alias.bin'),
      syntheticDestination,'write','trusted-owner','trusted-device',requestAlias),
      denial('FILE_NATIVE_CALLER_SOURCE_MISMATCH'));
    assert.equal(await fs.readFile(hardlink,'utf8'),'trusted data');
    assert.equal(await fs.readFile(ads,'utf8'),'different stream');
  });

test('W26/#673 source and parent reject stale same-handle observations after rename/reparse',()=>{
  const changes: Array<[string,(w:VerifiedFilesystemBoundary)=>void]>=[
    ['source final path', w=>{w.source.finalPath='C:\\Users\\Public\\replacement.exe';}],
    ['source reparse', w=>{w.source.reparseTag=0xA0000003;}],
    ['source reread file', w=>{w.source.observedAfter.fileId='replacement-id';}],
    ['source reread volume', w=>{w.source.observedAfter.volumeGuid='different-volume';}],
    ['source no-follow absent', w=>{w.source.noFollowVerified=false;}],
    ['destination parent reparse', w=>{w.destinationParent.reparseTag=0xA0000003;}],
    ['destination parent renamed', w=>{w.destinationParent.finalPath='C:\\Protected\\other';}],
    ['destination parent replaced', w=>{w.destinationParent.observedAfter.fileId='new-dir-id';}],
    ['destination parent wrong volume', w=>{w.destinationParent.observedAfter.diskId='other-disk';}],
  ];
  for(const [reason,mutate] of changes){
    const w=syntheticProtectedBoundary();mutate(w);
    assert.throws(()=>verify(w),denial('FILE_NATIVE_HANDLE_IDENTITY_UNVERIFIED'),reason);
  }
  // A once-valid source witness is not a continuous OS subscription.
  // There is no mutation executor connected to turn this snapshot into a guarantee.
  assert.equal(verify(syntheticProtectedBoundary()).sourceFileId,'source-id');
});

test('W26/#673 protected parent, updater and module ACL/signer: unavailable is always DENY',()=>{
  for(const role of ['parent','updater','module'] as ProtectedRole[]){
    for(const [reason,mutate,code] of [
      ['provider UNAVAILABLE',(w:VerifiedFilesystemBoundary)=>
        {w.protectedComponents[role].provider='unavailable';},
        'FILE_NATIVE_PROTECTED_ACL_UNVERIFIED'],
      ['writable ACL',(w:VerifiedFilesystemBoundary)=>
        {w.protectedComponents[role].untrustedWriteOrDeleteOrOwnerRights=true;},
        'FILE_NATIVE_PROTECTED_ACL_UNVERIFIED'],
      ['untrusted owner',(w:VerifiedFilesystemBoundary)=>
        {w.protectedComponents[role].aclOwnerSid='S-1-5-11';},
        'FILE_NATIVE_PROTECTED_ACL_UNVERIFIED'],
      ['missing import attestation',(w:VerifiedFilesystemBoundary)=>
        {w.protectedComponents[role].pinnedPublisherAndDigest=false;},
        'FILE_NATIVE_PROTECTED_ACL_UNVERIFIED'],
      ['descendants unexamined',(w:VerifiedFilesystemBoundary)=>
        {w.protectedComponents[role].descendantsChecked=false;},
        'FILE_NATIVE_PROTECTED_ACL_UNVERIFIED'],
      ['replaced handle',(w:VerifiedFilesystemBoundary)=>
        {w.protectedComponents[role].handle.observedAfter.fileId='new-dll-tree';},
        'FILE_NATIVE_HANDLE_IDENTITY_UNVERIFIED'],
      ['reparse updater parent',(w:VerifiedFilesystemBoundary)=>
        {w.protectedComponents[role].handle.reparseTag=0xA0000003;},
        'FILE_NATIVE_HANDLE_IDENTITY_UNVERIFIED'],
    ] as Array<[string,(w:VerifiedFilesystemBoundary)=>void,string]>){
      const w=syntheticProtectedBoundary();mutate(w);
      assert.throws(()=>verify(w),denial(code),role+' '+reason);
    }
  }
});

test('W26/#673 known evidence gap: updater DLL dependency graph not represented by boolean',()=>{
  const w=syntheticProtectedBoundary();
  // DO NOT interpret this as an approved signer. A model can carry a true
  // publisherAndDigest boolean while no list of actual DLL paths/digests exists.
  Object.assign(w.protectedComponents.updater,{
    injectedDllPath:'C:\\ProgramData\\Nexowire\\updater\\untrusted.dll',
    injectedDllAttested:false,
  });
  assert.equal(w.protectedComponents.updater.pinnedPublisherAndDigest,true);
  assert.doesNotThrow(()=>verify(w),
    'This exposes absence of per-import DAG evidence, NOT real ACL PASS');
});

function boundedSparseMetadata(size:bigint,position:bigint,length:bigint) {
  const max=BigInt(Number.MAX_SAFE_INTEGER);
  if(size<0n||size>max||position<0n||position>max||length<1n||
     length>BigInt(KB64)||position>size||length>size-position){
    throw new RangeError('UNSAFE_SPARSE_METADATA');
  }
  return {position:Number(position),byteCount:Number(length)};
}
test('W26/#673 simulated sparse 4GiB+ metadata does not wrap 32-bit or allocate a file',()=>{
  const boundary=1n<<32n,logicalSize=boundary+BigInt(KB64)+99n;
  const r=boundedSparseMetadata(logicalSize,boundary+2n,BigInt(KB64));
  assert.deepEqual(r,{position:4_294_967_298,byteCount:KB64});
  assert.notEqual(r.position,r.position>>>0);
  const seed=Buffer.alloc(32,0x7a);
  const digest=createHash('sha256').update(seed).digest('hex');
  assert.equal(digest.length,64,'tiny synthetic readback only');
  for(const args of [
    [logicalSize,logicalSize-3n,4n],
    [logicalSize,boundary+1n,BigInt(KB64)+1n],
    [logicalSize,-1n,1n],
    [logicalSize,0n,0n],
    [BigInt(Number.MAX_SAFE_INTEGER)+1n,0n,1n],
    [logicalSize,BigInt(Number.MAX_SAFE_INTEGER)+2n,1n],
  ] as const) assert.throws(()=>boundedSparseMetadata(args[0],args[1],args[2]),RangeError);
  // No truncate(), sparse OS file, 1GiB allocation, data disk writes or VM.
});
