import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PathPolicy, PathDeniedError } from '../src/agent/path-policy.js';

// Native kernel32 identity probes. Only disposable temporary test objects.
// They do not prove atomic Win32 directory-handle-relative mutations.
const windowsOnly = process.platform !== 'win32' ? 'requires Windows NTFS' : false;
const csharp = [
  'using System;',
  'using System.IO;',
  'using System.ComponentModel;',
  'using System.Runtime.InteropServices;',
  'using Microsoft.Win32.SafeHandles;',
  'public static class NxP05Probe {',
  ' [StructLayout(LayoutKind.Sequential)] public struct FT { public uint a,b; }',
  ' [StructLayout(LayoutKind.Sequential)] public struct INFO {',
  '  public uint attrs; public FT c,a,w;',
  '  public uint volume,sizeHi,sizeLo,links,indexHi,indexLo; }',
  ' [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]',
  ' static extern SafeFileHandle Open(string p,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);',
  ' [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandle",SetLastError=true)]',
  ' static extern bool Info(SafeFileHandle h,out INFO i);',
  ' [DllImport("kernel32.dll",EntryPoint="GetFinalPathNameByHandleW",CharSet=CharSet.Unicode,SetLastError=true)]',
  ' static extern uint Final(SafeFileHandle h,System.Text.StringBuilder b,uint count,uint flags);',
  ' static SafeFileHandle OpenRead(string p) {',
  '  var h=Open(p,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);',
  '  if(h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '  return h;',
  ' }',
  ' static INFO HandleInfo(SafeFileHandle h) {',
  '  INFO i;',
  '  if(!Info(h,out i)) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '  return i;',
  ' }',
  ' static string Key(INFO i) { return i.volume.ToString("X8")+":"+i.indexHi.ToString("X8")+":"+i.indexLo.ToString("X8"); }',
  ' public static string[] Inspect(string p) {',
  '  using(var h=OpenRead(p)) {',
  '   var i=HandleInfo(h); var b=new System.Text.StringBuilder(2048);',
  '   uint n=Final(h,b,2048,0);',
  '   if(n==0 || n>=2048) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '   return new string[]{Key(i),i.links.ToString(),(i.attrs & 0x400)!=0 ? "REPARSE":"REGULAR",b.ToString()};',
  '  }',
  ' }',
  ' public static string[] RetainWhileRename(string a,string b) {',
  '  using(var h=OpenRead(a)) {',
  '   var before=Key(HandleInfo(h)); File.Move(a,b);',
  '   var after=Key(HandleInfo(h)); File.WriteAllBytes(a,new byte[]{99});',
  '   return new string[]{before,after,Inspect(a)[0]};',
  '  }',
  ' }',
  '}',
].join('\n');
const quote = (s: string) => "'" + s.replace(/'/g,"''") + "'";
function native(commands:string[]):string[][] {
  const powershell = "$ErrorActionPreference='Stop'\n" +
    "Add-Type -TypeDefinition @'\n" + csharp + "\n'@\n" +
    "$result=@(\n" + commands.map(s=>" ,("+s+")").join("\n") +
    "\n); ConvertTo-Json -InputObject $result -Compress";
  return JSON.parse(execFileSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(powershell,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:32768},
  ).trim()) as string[][];
}
test('real Windows CreateFileW handle identity, junction, hardlink, ADS and rename',
  {skip:windowsOnly,timeout:60000},async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-p05-native-handle-'));
    t.after(async()=>{await fs.rm(dir,{recursive:true,force:true});});
    const regular=path.join(dir,'base.bin');
    const alias=path.join(dir,'hardlink.bin');
    const target=path.join(dir,'directory');
    const junction=path.join(dir,'junction');
    const stream=regular+':nexowire_test_stream';
    const renamed=path.join(dir,'renamed.bin');
    await fs.writeFile(regular,'original');
    await fs.link(regular,alias);
    await fs.mkdir(target);
    await fs.symlink(target,junction,'junction');
    await fs.writeFile(stream,'alternate data');
    const samples=native([
      '[NxP05Probe]::Inspect('+quote(regular)+')',
      '[NxP05Probe]::Inspect('+quote(alias)+')',
      '[NxP05Probe]::Inspect('+quote(junction)+')',
      '[NxP05Probe]::Inspect('+quote(stream)+')',
      '[NxP05Probe]::RetainWhileRename('+quote(regular)+','+quote(renamed)+')',
    ]);
    assert.equal(samples.length,5);
    const [base,hardlink,reparse,ads,retained]=samples;
    assert.ok(base && hardlink && reparse && ads && retained);
    assert.equal(base[0],hardlink[0]);
    assert.equal(base[1],'2');
    assert.equal(reparse[2],'REPARSE');
    assert.equal(ads[0],base[0]);
    assert.notEqual(ads[3],base[3]);
    assert.equal(retained[0],retained[1]);
    assert.notEqual(retained[0],retained[2]);
    const policy=new PathPolicy([dir],{platform:'win32',defaultScopes:['read','write']});
    await assert.rejects(()=>policy.authorizeExisting(stream,'read'),
      (e:unknown)=>e instanceof PathDeniedError);
    await assert.rejects(()=>policy.authorizeForCreate(stream,'write'),
      (e:unknown)=>e instanceof PathDeniedError);
  });
