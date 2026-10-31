import {promises as fs} from 'node:fs';
import {spawn} from 'node:child_process';
import {windowsDpapiChildEnvironment} from '../security/windows-dpapi.js';

export type JournalOwnerProcess={state:'alive';identity:string}|{state:'dead'|'unknown'};
const script=String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NxJournalProcess {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long c,out long e,out long k,out long u);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint exit);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static string Read(uint pid){
  var h=OpenProcess(0x1000,false,pid);
  if(h==IntPtr.Zero)return Marshal.GetLastWin32Error()==87?"dead":"unknown";
  try {long c,e,k,u;uint code;
   if(!GetProcessTimes(h,out c,out e,out k,out u)||!GetExitCodeProcess(h,out code))return "unknown";
   if(code!=259)return "dead";
   return "win32:"+c.ToString("x16");
  }finally{CloseHandle(h);}
 }
}
'@
$idValue=[uint32]([Console]::In.ReadToEnd())
[Console]::Out.Write([NxJournalProcess]::Read($idValue))
`;
/** OS incarnation, never PID liveness alone. Access denial/ambiguity blocks
 * takeover. Does not signal, terminate, checkpoint or edit another process. */
let selfIdentity:Promise<JournalOwnerProcess>|undefined;
export function readJournalOwnerProcess(pid:number):Promise<JournalOwnerProcess>{
  if(pid===process.pid)return selfIdentity??=readProcess(pid);
  return readProcess(pid);
}
async function readProcess(pid:number):Promise<JournalOwnerProcess>{
  if(!Number.isSafeInteger(pid)||pid<=0||pid>0x7fffffff)return {state:'unknown'};
  try{
    if(process.platform==='linux'){
      // Some sandbox runtimes expose a host /proc with different PID numbers.
      // Never attribute that unrelated host process to this namespace's PID.
      const ownStat=await fs.readFile('/proc/self/stat','utf8');
      if(Number(ownStat.slice(0,ownStat.indexOf(' ')))!==process.pid){
        try{process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return {state:'dead'};}
        return {state:'unknown'};
      }
      const boot=(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
      const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');
      const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
      if(!/^[a-f0-9-]{36}$/.test(boot)||!/^\d+$/.test(fields[19]??''))return {state:'unknown'};
      if(fields[0]==='Z'||fields[0]==='X')return {state:'dead'};
      return {state:'alive',identity:`linux:${boot}:${fields[19]}`};
    }
    if(process.platform==='win32'){
      return await new Promise<JournalOwnerProcess>(resolve=>{
        const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          ['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,
            env:windowsDpapiChildEnvironment(),stdio:['pipe','pipe','pipe']});
        let out='',done=false;
        const finish=(value:JournalOwnerProcess)=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
        const timer=setTimeout(()=>{child.kill();finish({state:'unknown'});},30000);
        child.stdout.on('data',b=>{out+=String(b);if(out.length>128){child.kill();finish({state:'unknown'});}});
        child.stderr.resume();child.stdin.on('error',()=>{});
        child.on('error',()=>finish({state:'unknown'}));
        child.on('close',code=>{const value=out.trim();
          finish(code===0&&/^win32:[a-f0-9]{16}$/.test(value)?{state:'alive',identity:value}:
            code===0&&value==='dead'?{state:'dead'}:{state:'unknown'});});
        child.stdin.end(String(pid));
      });
    }
    // Older/unsupported platforms retain the conservative PID guard below.
    return {state:'unknown'};
  }catch{
    try{process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return {state:'dead'};}
    return {state:'unknown'};
  }
}
