import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertNativeProtectedFileBoundary, NativeFileBoundaryError,
} from '../src/agent/windows-native-file-source-boundary.js';
import { authorizeNativeRelativeChain, assertEffectiveNativeAcl,
  RelativeAccessDenied } from '../src/agent/windows-native-relative-access.js';
import {
  syntheticProtectedBoundary, syntheticSource, syntheticDestination,
} from './p05-native-boundary-fixtures.js';

// W26 test-only, stacked on #690 exact SHA. Never treat the synthetic publisher,
// ACL, import list or path readback as a Windows Authenticode/installed-binary fact.
const onlyWindows = process.platform === 'win32' ? false : 'Win32 TEMP required';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const q = (s: string) => "'" + s.replaceAll("'", "''") + "'";
async function temporary(t: import('node:test').TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-w26-p690-'));
  t.after(async () => { await fs.rm(dir, {recursive:true,force:true}); });
  return dir;
}
const csharp = [
  'using System;',
  'using System.ComponentModel;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'using Microsoft.Win32.SafeHandles;',
  'public static class W26DAGNative {',
  ' [StructLayout(LayoutKind.Sequential)] public struct FT {public uint lo,hi;}',
  ' [StructLayout(LayoutKind.Sequential)] public struct BYHANDLE {',
  '  public uint attributes;public FT c,a,w;',
  '  public uint vol,sizeHi,sizeLo,links,idHi,idLo;}',
  ' [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]',
  ' static extern SafeFileHandle Open(string p,uint access,uint share,IntPtr sa,uint creation,uint flags,IntPtr t);',
  ' [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandle",SetLastError=true)]',
  ' static extern bool Info(SafeFileHandle h,out BYHANDLE i);',
  ' [DllImport("kernel32.dll",EntryPoint="GetFinalPathNameByHandleW",CharSet=CharSet.Unicode,SetLastError=true)]',
  ' static extern uint Final(SafeFileHandle h,StringBuilder b,uint n,uint flags);',
  ' static SafeFileHandle held;',
  ' static SafeFileHandle Attr(string p){var h=Open(p,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);',
  '  if(h.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());return h;}',
  ' static string[] Read(SafeFileHandle h){BYHANDLE i;',
  '  if(!Info(h,out i))throw new Win32Exception(Marshal.GetLastWin32Error());',
  '  var sb=new StringBuilder(32768);var n=Final(h,sb,(uint)sb.Capacity,1);',
  '  if(n==0||n>=(uint)sb.Capacity)throw new Win32Exception(Marshal.GetLastWin32Error());',
  '  return new string[]{i.vol.ToString("X8")+":"+i.idHi.ToString("X8")+":"+i.idLo.ToString("X8"),',
  '   sb.ToString(), ((i.attributes&0x400)!=0)?"REPARSE":"REGULAR",i.links.ToString()};}',
  ' public static string[] Inspect(string p){using(var h=Attr(p))return Read(h);}',
  ' public static string[] Hold(string p){held=Attr(p);return Read(held);}',
  ' public static string[] Held(){return Read(held);}',
  ' public static void Close(){if(held!=null){held.Dispose();held=null;}}',
  '}',
].join('\n');
function native(commands: string[]): Record<string,string[]> {
  const script="$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n"+
    "Add-Type -TypeDefinition @'\n"+csharp+"\n'@\n"+commands.join('\n')+
    '\nConvertTo-Json -InputObject $result -Depth 7 -Compress';
  const pwsh=path.join(process.env.SystemRoot??'C:\\Windows',
    'System32','WindowsPowerShell','v1.0','powershell.exe');
  return JSON.parse(execFileSync(pwsh,
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:128*1024}).trim())
    as Record<string,string[]>;
}

type DllProof = {
  name:string; deps:string[]; path:string;
  publisher:string; digest:string; fileId:string; volume:string;
  finalPath:string; linkCount:number; stream:string|null;
  noFollow:boolean; reparse:boolean;
};
type Manifest = Record<string, Omit<DllProof,'deps'> & {deps:string[]}>;
function authorizeTestOnlyImports(
  observed:Record<string,DllProof>, manifest:Manifest, root:string) {
  const seen=new Set<string>();
  const live=new Set<string>();
  function verify(name:string) {
    if(live.has(name))throw new Error('IMPORT_GRAPH_CYCLE');
    if(seen.has(name))return;
    const trusted=manifest[name], candidate=observed[name];
    if(!trusted||!candidate)throw new Error('IMPORT_GRAPH_INCOMPLETE');
    const keys=Object.keys(trusted.deps).length;
    if(candidate.deps.length!==keys ||
       [...candidate.deps].sort().join('|')!==[...trusted.deps].sort().join('|')) {
      throw new Error('IMPORT_GRAPH_EDGE_MISMATCH');
    }
    const relative=path.win32.relative(root,candidate.path);
    if(relative===''||relative==='..'||relative.startsWith('..\\')||
       path.win32.isAbsolute(relative)||candidate.stream!==null||
       candidate.linkCount!==1||!candidate.noFollow||candidate.reparse) {
      throw new Error('IMPORT_HANDLE_ALIAS');
    }
    for(const k of ['path','publisher','digest','fileId','volume','finalPath'] as const) {
      if(candidate[k]!==trusted[k])throw new Error('IMPORT_PER_NODE_'+k.toUpperCase());
    }
    live.add(name);
    for(const dep of candidate.deps)verify(dep);
    live.delete(name);seen.add(name);
  }
  verify('updater.exe');
  if(seen.size!==Object.keys(observed).length ||
     seen.size!==Object.keys(manifest).length){
    throw new Error('IMPORT_GRAPH_ORPHAN_OR_EXTRA');
  }
  return true;
}
function testGraph() {
  const root='C:\\TEMP\\w26-protected\\updater';
  const names=['updater.exe','stage.dll','nested.dll'];
  const manifest={} as Manifest;
  for(let i=0;i<names.length;i++){
    const name=names[i]!;
    manifest[name]={
      name,path:path.win32.join(root,name),publisher:'synthetic-publisher',
      digest:sha(Buffer.from('sealed:'+name)),fileId:'pinned-'+name,
      volume:'synthetic-volume',finalPath:path.win32.join(root,name),
      linkCount:1,stream:null,noFollow:true,reparse:false,
      deps: i<names.length-1?[names[i+1]!]:[],
    };
  }
  return {root,manifest,observed:structuredClone(manifest) as Record<string,DllProof>};
}

test('W26/#690: separately pinned imported DLL hashes, publisher, file ID, volume and edges fail closed',()=>{
  const baseline=testGraph();
  assert.equal(authorizeTestOnlyImports(baseline.observed,baseline.manifest,baseline.root),true);
  const changes:Array<[string,(g:ReturnType<typeof testGraph>)=>void]>=[
    ['publisher',g=>{g.observed['stage.dll']!.publisher='other-publisher';}],
    ['hash',g=>{g.observed['nested.dll']!.digest='forged-hash';}],
    ['same publisher replacement file ID',g=>{g.observed['stage.dll']!.fileId='replaced-dll';}],
    ['other volume',g=>{g.observed['stage.dll']!.volume='foreign-volume';}],
    ['retargeted final path',g=>{g.observed['nested.dll']!.finalPath='C:\\TEMP\\outside\\nested.dll';}],
    ['untrusted hardlink',g=>{g.observed['nested.dll']!.linkCount=2;}],
    ['ADS',g=>{g.observed['nested.dll']!.stream='evil';}],
    ['junction',g=>{g.observed['nested.dll']!.reparse=true;}],
    ['no-follow absent',g=>{g.observed['nested.dll']!.noFollow=false;}],
    ['missing transitive DLL',g=>{delete g.observed['nested.dll'];}],
    ['unlisted extra DLL',g=>{g.observed['extra.dll']={...g.observed['nested.dll']!,name:'extra.dll'};}],
    ['unlisted edge',g=>{g.observed['stage.dll']!.deps=[];}],
    ['cyclic load',g=>{g.observed['nested.dll']!.deps=['updater.exe'];g.manifest['nested.dll']!.deps=['updater.exe'];}],
  ];
  for(const [label,tamper] of changes){
    const graph=testGraph();tamper(graph);
    assert.throws(()=>authorizeTestOnlyImports(graph.observed,graph.manifest,graph.root),
      Error,label);
  }
});

test('W26/#690 owner source still ACCEPTS unlisted transitive DLL when role-level boolean is true',()=>{
  const owner=syntheticProtectedBoundary();
  const updater=owner.protectedComponents.updater;
  Object.assign(updater,{
    // Deliberately extra, unrecognized data. This is a SOURCE CONTRACT GAP,
    // not a bypass against an actual installed authenticator.
    transitiveDlls:[{name:'nested.dll',publisherVerified:false,
      digestVerified:false,handleVerified:false}],
  });
  assert.equal(updater.pinnedPublisherAndDigest,true);
  assert.doesNotThrow(()=>assertNativeProtectedFileBoundary(
    syntheticSource,syntheticDestination,'write','trusted-owner','trusted-device',owner));
  const strict=testGraph();
  strict.observed['nested.dll']!.digest='unverified';
  assert.throws(()=>authorizeTestOnlyImports(strict.observed,strict.manifest,strict.root),
    /IMPORT_PER_NODE_DIGEST/);
});

test('W26/#690 effective parent/updater/module ACE and handle-relative volume grants deny independently',()=>{
  const roles=['parent','updater','module'] as const;
  for(const role of roles){
    for(const mutate of [
      (x:ReturnType<typeof syntheticProtectedBoundary>)=>{x.protectedComponents[role].effectiveAcl.aces=[
        ...x.protectedComponents[role].effectiveAcl.aces,
        {sid:'S-1-5-11',type:'allow',accessMask:0x40000,inheritOnly:false}];},
      (x:ReturnType<typeof syntheticProtectedBoundary>)=>{x.protectedComponents[role].effectiveAcl.provider='unavailable';},
      (x:ReturnType<typeof syntheticProtectedBoundary>)=>{x.protectedComponents[role].handle.observedAfter.fileId='new-parent-id';},
      (x:ReturnType<typeof syntheticProtectedBoundary>)=>{x.protectedComponents[role].handle.reparseTag=0xA0000003;},
    ]) {
      const x=syntheticProtectedBoundary();mutate(x);
      assert.throws(()=>assertNativeProtectedFileBoundary(
        syntheticSource,syntheticDestination,'write','trusted-owner','trusted-device',x),
      e=>e instanceof RelativeAccessDenied||e instanceof NativeFileBoundaryError);
    }
  }
  const x=syntheticProtectedBoundary();
  x.destinationRelativeChain.grantRoot.volumeGuid='wrong-volume';
  assert.throws(()=>authorizeNativeRelativeChain(
    x.destinationRelativeChain,x.grant.root,syntheticDestination),
    e=>e instanceof RelativeAccessDenied);
  const valid=syntheticProtectedBoundary();
  assert.doesNotThrow(()=>assertEffectiveNativeAcl(
    valid.protectedComponents.updater.effectiveAcl,
    valid.protectedComponents.updater.handle));
});

test('W26/#690 real Windows TEMP DLL hardlink/ADS share same native ID but cannot inherit import authorization',
  {skip:onlyWindows,timeout:60000},async t=>{
  const dir=await temporary(t),root=path.join(dir,'installed');
  const foreign=path.join(dir,'foreign');
  await fs.mkdir(root);await fs.mkdir(foreign);
  const dll=path.join(root,'nested.dll'),alias=path.join(foreign,'nested.dll');
  const ads=dll+':other_stream';
  await fs.writeFile(dll,Buffer.from('benign synthetic bytes'));
  await fs.link(dll,alias);
  await fs.writeFile(ads,Buffer.from('malicious stream'));
  const r=native([
    '$result=[ordered]@{',
    ' main=[W26DAGNative]::Inspect('+q(dll)+')',
    ' hardlink=[W26DAGNative]::Inspect('+q(alias)+')',
    ' ads=[W26DAGNative]::Inspect('+q(ads)+')',
    '}',
  ]);
  assert.equal(r.main?.[0],r.hardlink?.[0]);
  assert.equal(r.main?.[0],r.ads?.[0]);
  assert.ok(Number(r.main?.[3])>=2);
  assert.notEqual(r.main?.[1],r.ads?.[1]);
  const g=testGraph();
  const expected=g.manifest['nested.dll']!;
  expected.fileId=r.main![0]!;
  expected.volume=r.main![1]!.split('}\\')[0]+'}\\';
  expected.path=dll;expected.finalPath=r.main![1]!;
  g.observed['nested.dll']={...expected,linkCount:Number(r.main![3])};
  assert.throws(()=>authorizeTestOnlyImports(g.observed,g.manifest,g.root),
    /IMPORT_HANDLE_ALIAS/);
  assert.equal((await fs.readFile(alias)).toString(),'benign synthetic bytes');
  assert.equal((await fs.readFile(ads)).toString(),'malicious stream');
});

test('W26/#690 real Windows TEMP junction handle is pinned across rename and retarget, not a trusted imported DLL',
  {skip:onlyWindows,timeout:60000},async t=>{
  const dir=await temporary(t);
  const good=path.join(dir,'good'),evil=path.join(dir,'evil');
  const junction=path.join(dir,'updater-current'),moved=path.join(dir,'updater-old');
  await fs.mkdir(good);await fs.mkdir(evil);
  await fs.writeFile(path.join(good,'module.dll'),'GOOD');
  await fs.writeFile(path.join(evil,'module.dll'),'EVIL');
  try {await fs.symlink(good,junction,'junction');}
  catch(e){const code=(e as NodeJS.ErrnoException).code;
    if(['EPERM','ENOTSUP','EOPNOTSUPP'].includes(code??'')){
      t.skip('TEMP junction unavailable: '+code);return;
    }throw e;
  }
  const r=native([
    '$before=[W26DAGNative]::Hold('+q(junction)+')',
    'try {',
    ' [System.IO.Directory]::Move('+q(junction)+','+q(moved)+')',
    ' New-Item -ItemType Junction -Path '+q(junction)+' -Target '+q(evil)+' -ErrorAction Stop|Out-Null',
    ' $held=[W26DAGNative]::Held()',
    ' $current=[W26DAGNative]::Inspect('+q(junction)+')',
    ' $result=[ordered]@{before=$before;held=$held;current=$current}',
    '} finally {[W26DAGNative]::Close()}',
  ]);
  assert.equal(r.before?.[2],'REPARSE');
  assert.equal(r.held?.[2],'REPARSE');
  assert.equal(r.before?.[0],r.held?.[0]);
  assert.notEqual(r.held?.[0],r.current?.[0]);
  assert.equal(await fs.readFile(path.join(junction,'module.dll'),'utf8'),'EVIL');
  assert.equal(await fs.readFile(path.join(moved,'module.dll'),'utf8'),'GOOD');
});

function virtualRange(size:bigint,position:bigint,length:bigint) {
  const limit=BigInt(Number.MAX_SAFE_INTEGER);
  if(size<0n||size>limit||position<0n||position>limit||
     length<1n||length>65536n||position>size||length>size-position) {
    throw new RangeError('SPARSE_RANGE_REJECTED');
  }
  return {position:Number(position),bytes:Number(length)};
}
test('W26/#690 sparse simulated 4GiB offsets preserve BigInt and reject 32-bit/unsafe ranges',()=>{
  const four=1n<<32n, size=four+65540n;
  assert.deepEqual(virtualRange(size,four+3n,65536n),
    {position:4294967299,bytes:65536});
  assert.notEqual(Number(four+3n),Number((four+3n)&0xffff_ffffn));
  for(const [s,p,l] of [
    [size,size-1n,2n],[size,four,65537n],
    [size,-1n,1n],[size,0n,0n],
    [(1n<<53n)+1n,0n,1n],
    [size,(1n<<53n)+1n,1n],
  ] as const)assert.throws(()=>virtualRange(s,p,l),RangeError);
  assert.equal(sha(Buffer.alloc(32)).length,64);
  // No sparse disk image, large allocation, or real 4GiB read/write.
});
