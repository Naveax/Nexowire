import {spawn} from 'node:child_process';
import * as z from 'zod';
import {windowsDpapiChildEnvironment} from '../security/windows-dpapi.js';
import {requiresPhysicalConsoleGrant} from './windows-console-grant.js';

export const CORE_POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const hwnd=z.string().max(32).regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/);
const selector=z.strictObject({automation_id:z.string().min(1).max(1024).optional(),
  name:z.string().min(1).max(1024).optional(),class_name:z.string().min(1).max(1024).optional(),
  control_type:z.string().min(1).max(128).optional()}).refine(s=>Object.keys(s).length>0);
export function parseCoreNativeInput(capability:string,input:unknown):Record<string,unknown>{
  if(!requiresPhysicalConsoleGrant(capability))throw new Error('CORE_NATIVE_SCOPE_DENIED');
  if(capability==='windows.keyboard.type')return z.strictObject({hwnd,text:z.string().min(1).max(20000),interval_ms:z.number().int().min(0).max(100).default(0)}).parse(input);
  if(capability==='windows.keyboard.hotkey')return z.strictObject({hwnd,keys:z.array(z.string().min(1).max(32).regex(/^[A-Za-z0-9_]+$/)).min(1).max(8)}).parse(input);
  if(capability==='windows.clipboard.write')return z.strictObject({text:z.string().min(1).max(100000)}).parse(input);
  if(capability==='windows.clipboard.clear'||capability==='windows.private_desktop.show')return z.strictObject({}).parse(input);
  if(capability==='windows.window.focus')return z.strictObject({hwnd,restore_if_minimized:z.boolean().default(true)}).parse(input);
  if(capability.startsWith('windows.pointer.'))return z.strictObject({hwnd,
    coordinate_mode:z.enum(['client_pixels','normalized']).default('client_pixels'),
    x:z.number().finite(),y:z.number().finite(),button:z.enum(['left','right','middle']).default('left'),
    count:z.number().int().min(1).max(3).default(1),interval_ms:z.number().int().min(20).max(1000).default(100),
    delta:z.number().int().min(-12000).max(12000).optional(),horizontal:z.boolean().default(false),
  }).superRefine((v,c)=>{
    if(v.coordinate_mode==='normalized'&&(v.x<0||v.x>1||v.y<0||v.y>1))c.addIssue({code:'custom',message:'Invalid normalized point'});
    if(v.coordinate_mode==='client_pixels'&&(!Number.isInteger(v.x)||!Number.isInteger(v.y)))c.addIssue({code:'custom',message:'Integer client pixels required'});
    if(capability==='windows.pointer.scroll'&&(!v.delta||v.delta===0))c.addIssue({code:'custom',message:'Nonzero scroll delta required'});
  }).parse(input);
  if(capability==='windows.accessibility.invoke')return z.strictObject({hwnd,selector}).parse(input);
  if(capability==='windows.accessibility.set_value')return z.strictObject({hwnd,selector,value:z.string().max(100000)}).parse(input);
  throw new Error('CORE_NATIVE_SCOPE_DENIED');
}

// Runs as the interactive Agent user, never via the HIGH Broker. Native target
// handles remain open for the whole operation; every key-down/mouse effect
// checks desktop, session, PID+creation time, foreground, STOP and deadline.
export const CORE_NATIVE_DEFINITION=String.raw`
using System;
using System.Text;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class NxCoreConsole {
 [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint f,bool inherit,uint access);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr d);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h,int n,StringBuilder b,int len,out int needed);
 [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
 [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint id);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint rights,bool inherit,uint pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr p,out long creation,out long exit,out long kernel,out long user);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p,out uint code);
 [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid,out uint session);
 [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr p,uint rights,out IntPtr token);
 [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token,int cls,IntPtr data,int size,out int needed);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint n);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int cmd);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref POINT p);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr OpenDesktop(string name,uint flags,bool inherit,uint access);
 [DllImport("user32.dll")] static extern bool SwitchDesktop(IntPtr desktop);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
 [StructLayout(LayoutKind.Sequential)] struct POINT {public int x,y;}
 [StructLayout(LayoutKind.Sequential)] struct RECT {public int left,top,right,bottom;}
 [StructLayout(LayoutKind.Sequential)] struct MOUSE {public int x,y;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] struct KEY {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] struct UNION {[FieldOffset(0)]public MOUSE mouse;[FieldOffset(0)]public KEY key;}
 [StructLayout(LayoutKind.Sequential)] struct INPUT {public uint type;public UNION u;}
 static IntPtr target,process,parentProcess;
 static uint pid;static long creation;static bool foreground;
 public static bool EffectAttempted=false;
 public static void MarkEffect(){Assert();EffectAttempted=true;}
 static string stopFile;static Stopwatch clock;
 static string Name(IntPtr h){int n;var b=new StringBuilder(256);if(h==IntPtr.Zero||!GetUserObjectInformation(h,2,b,512,out n))throw new Exception("CORE_DESKTOP_UNKNOWN");return b.ToString();}
 static int Integrity(IntPtr p){IntPtr token;if(!OpenProcessToken(p,8,out token))throw new Exception("CORE_TOKEN_UNKNOWN");try{int n;GetTokenInformation(token,25,IntPtr.Zero,0,out n);if(n<8||n>65536)throw new Exception("CORE_TOKEN_UNKNOWN");var b=Marshal.AllocHGlobal(n);try{if(!GetTokenInformation(token,25,b,n,out n))throw new Exception("CORE_TOKEN_UNKNOWN");var sid=Marshal.ReadIntPtr(b);int count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));return Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));}finally{Marshal.FreeHGlobal(b);}}finally{CloseHandle(token);}}
 public static bool DesktopAllowed(){try{
   var d=OpenInputDesktop(0,false,1);if(d==IntPtr.Zero)return false;
   try{return Name(d)=="Default"&&Name(GetProcessWindowStation())=="WinSta0"&&Name(GetThreadDesktop(GetCurrentThreadId()))=="Default"&&Integrity(Process.GetCurrentProcess().Handle)==8192;}finally{CloseDesktop(d);}
 }catch{return false;}}
 public static void Initialize(string raw,bool requireForeground,string stop,uint parentPid){
   stopFile=stop;clock=Stopwatch.StartNew();foreground=requireForeground;
   parentProcess=OpenProcess(0x1000,false,parentPid);uint parentExit;
   if(parentProcess==IntPtr.Zero||!GetExitCodeProcess(parentProcess,out parentExit)||parentExit!=259)throw new Exception("CORE_AGENT_NOT_RUNNING");
   if(!String.IsNullOrEmpty(raw)){
     long value=raw.StartsWith("0x",StringComparison.OrdinalIgnoreCase)?Convert.ToInt64(raw.Substring(2),16):Convert.ToInt64(raw,10);
     target=new IntPtr(value);if(!IsWindow(target)||GetWindowThreadProcessId(target,out pid)==0)throw new Exception("CORE_TARGET_INVALID");
     process=OpenProcess(0x1000,false,pid);if(process==IntPtr.Zero)throw new Exception("CORE_TARGET_UNAVAILABLE");
     long e,k,u;if(!GetProcessTimes(process,out creation,out e,out k,out u))throw new Exception("CORE_TARGET_IDENTITY_UNKNOWN");
     uint session;if(!ProcessIdToSessionId(pid,out session)||session!=(uint)Process.GetCurrentProcess().SessionId||Integrity(process)>8192)throw new Exception("CORE_TARGET_SESSION_OR_INTEGRITY_DENIED");
   }
   Assert();
 }
 public static void Assert(){
   uint parentExit;if(parentProcess==IntPtr.Zero||!GetExitCodeProcess(parentProcess,out parentExit)||parentExit!=259)throw new Exception("CORE_AGENT_STOPPED");
   if(clock==null||clock.ElapsedMilliseconds>25000||(!String.IsNullOrEmpty(stopFile)&&(File.Exists(stopFile)||File.Exists(stopFile+".blocked")))||!DesktopAllowed())throw new Exception("CORE_STOPPED_OR_DESKTOP_DENIED");
   if(target!=IntPtr.Zero){uint current,exit;long c,e,k,u;
     if(!IsWindow(target)||GetWindowThreadProcessId(target,out current)==0||current!=pid||!GetExitCodeProcess(process,out exit)||exit!=259||!GetProcessTimes(process,out c,out e,out k,out u)||c!=creation)throw new Exception("CORE_TARGET_CHANGED");
     if(foreground&&GetForegroundWindow()!=target)throw new Exception("CORE_TARGET_NOT_FOREGROUND");
   }
 }
 static void Send(INPUT input,bool cleanup){if(!cleanup)Assert();EffectAttempted=true;if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("CORE_INPUT_DENIED_BY_WINDOWS");}
 static void Key(ushort vk,ushort scan,uint flags){Send(new INPUT{type=1,u=new UNION{key=new KEY{vk=vk,scan=scan,flags=flags}}},(flags&2)!=0);}
 public static void Text(string text,int interval){foreach(char c in text){Assert();try{Key(0,c,4);}finally{Key(0,c,6);}if(interval>0)Thread.Sleep(interval);}}
 public static void Chord(ushort[] keys){int pressed=0;try{for(int i=0;i<keys.Length;i++){Key(keys[i],0,0);pressed++;}}finally{for(int i=pressed-1;i>=0;i--){try{Key(keys[i],0,2);}catch{}}}}
 static void Mouse(uint flags,int data,bool cleanup){Send(new INPUT{type=0,u=new UNION{mouse=new MOUSE{flags=flags,data=unchecked((uint)data)}}},cleanup);}
 public static void Point(double x,double y,bool normalized){Assert();RECT r;if(!GetClientRect(target,out r))throw new Exception("CORE_TARGET_RECT_UNAVAILABLE");
   var p=new POINT{x=normalized?(int)Math.Round(x*Math.Max(0,r.right-1)):(int)x,y=normalized?(int)Math.Round(y*Math.Max(0,r.bottom-1)):(int)y};
   if(p.x<0||p.y<0||p.x>=r.right||p.y>=r.bottom||!ClientToScreen(target,ref p))throw new Exception("CORE_POINT_OUTSIDE_TARGET");
   MarkEffect();if(!SetCursorPos(p.x,p.y))throw new Exception("CORE_POINTER_DENIED");
 }
 public static void Click(string button,int count,int interval){uint down=button=="right"?8u:button=="middle"?32u:2u;uint up=down*2;
   for(int i=0;i<count;i++){Assert();try{Mouse(down,0,false);}finally{Mouse(up,0,true);}if(i+1<count)Thread.Sleep(interval);}}
 public static void Scroll(int delta,bool horizontal){Mouse(horizontal?0x1000u:0x800u,delta,false);}
 public static void Focus(bool restore){MarkEffect();if(restore&&IsIconic(target))ShowWindow(target,9);Assert();if(!SetForegroundWindow(target)||GetForegroundWindow()!=target)throw new Exception("CORE_FOCUS_DENIED");}
 public static uint TargetPid(){return pid;}
 public static void PrivateDesktop(){Assert();var d=OpenDesktop("NexowirePrivate",0,false,0x100);if(d==IntPtr.Zero)throw new Exception("CORE_PRIVATE_DESKTOP_UNAVAILABLE");try{MarkEffect();if(!SwitchDesktop(d))throw new Exception("CORE_SWITCH_DENIED");}finally{CloseDesktop(d);}}
}
`;

const nativeScript=String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
${CORE_NATIVE_DEFINITION}
'@
$p=[Console]::In.ReadToEnd()|ConvertFrom-Json
$cap=[string]$p.capability
$target=[string]$p.input.hwnd
$foreground=$cap -like 'windows.keyboard.*' -or $cap -like 'windows.pointer.*'
try {
[NxCoreConsole]::Initialize($target,$foreground,[string]$p.stopFile,[uint32]$p.agentPid)
switch($cap){
 'probe' { }
 'windows.keyboard.type' {[NxCoreConsole]::Text([string]$p.input.text,[int]$p.input.interval_ms)}
 'windows.keyboard.hotkey' {
   $aliases=@{CTRL=17;CONTROL=17;ALT=18;SHIFT=16;WIN=91;META=91;ENTER=13;RETURN=13;ESC=27;ESCAPE=27;SPACE=32;TAB=9;BACKSPACE=8;BACK=8;DELETE=46;DEL=46;PGUP=33;PGDN=34}
   $keys=@();foreach($name in $p.input.keys){$n=([string]$name).ToUpperInvariant();
     $keys+=if($aliases.ContainsKey($n)){[ushort]$aliases[$n]}elseif($n -match '^[A-Z0-9]$'){[ushort][char]$n}else{[ushort][Enum]::Parse([System.Windows.Forms.Keys],$n,$true)}
   }
   if($keys -contains 17 -and $keys -contains 18 -and $keys -contains 46){throw 'CORE_SECURE_ATTENTION_DENIED'}
   [NxCoreConsole]::Chord([ushort[]]$keys)
 }
 'windows.window.focus' {[NxCoreConsole]::Focus([bool]$p.input.restore_if_minimized)}
 'windows.clipboard.write' {[NxCoreConsole]::MarkEffect();[System.Windows.Forms.Clipboard]::SetText([string]$p.input.text)}
 'windows.clipboard.clear' {[NxCoreConsole]::MarkEffect();[System.Windows.Forms.Clipboard]::Clear()}
 'windows.private_desktop.show' {[NxCoreConsole]::PrivateDesktop()}
 {$_ -like 'windows.pointer.*'} {
   [NxCoreConsole]::Point([double]$p.input.x,[double]$p.input.y,($p.input.coordinate_mode -eq 'normalized'))
   if($cap -eq 'windows.pointer.click'){[NxCoreConsole]::Click([string]$p.input.button,[int]$p.input.count,[int]$p.input.interval_ms)}
   if($cap -eq 'windows.pointer.scroll'){[NxCoreConsole]::Scroll([int]$p.input.delta,[bool]$p.input.horizontal)}
 }
 {$_ -like 'windows.accessibility.*'} {
   Add-Type -AssemblyName UIAutomationClient
   Add-Type -AssemblyName UIAutomationTypes
   $raw=[string]$p.input.hwnd;$value=if($raw.StartsWith('0x')){[Convert]::ToInt64($raw.Substring(2),16)}else{[Convert]::ToInt64($raw)}
   $root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($value))
   $queue=New-Object 'System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]';$queue.Enqueue($root)
   $matches=@();$nodes=0;$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
   while($queue.Count -gt 0){
     [NxCoreConsole]::Assert();if(++$nodes -gt 2000){throw 'CORE_UIA_BUDGET_EXHAUSTED'}
     $e=$queue.Dequeue();$current=$e.Current;$match=$true
     foreach($s in $p.input.selector.PSObject.Properties){$actual=switch($s.Name){'automation_id'{$current.AutomationId};'name'{$current.Name};'class_name'{$current.ClassName};'control_type'{$current.ControlType.ProgrammaticName.Replace('ControlType.','')}};if([string]$actual -cne [string]$s.Value){$match=$false}}
     if($match){$matches+=,$e;if($matches.Count -gt 1){throw 'CORE_UIA_AMBIGUOUS'}}
     $child=$walker.GetFirstChild($e);while($null -ne $child){if($queue.Count -ge 2000){throw 'CORE_UIA_BUDGET_EXHAUSTED'};$queue.Enqueue($child);$child=$walker.GetNextSibling($child)}
   }
   if($matches.Count -ne 1){throw 'CORE_UIA_TARGET_NOT_FOUND'}
   $e=$matches[0];if($e.Current.ProcessId -ne [NxCoreConsole]::TargetPid() -or -not $e.Current.IsEnabled -or $e.Current.IsOffscreen){throw 'CORE_UIA_TARGET_CHANGED'}
   [NxCoreConsole]::MarkEffect()
   if($cap -eq 'windows.accessibility.invoke'){([System.Windows.Automation.InvokePattern]$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()}
   else{([System.Windows.Automation.ValuePattern]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue([string]$p.input.value)}
 }
 default {throw 'CORE_NATIVE_CAPABILITY_UNSUPPORTED'}
}
@{nativeEffectVerified=($cap -ne 'probe');guardVerified=$true;effectAttempted=[NxCoreConsole]::EffectAttempted;capability=$cap;targetPid=[NxCoreConsole]::TargetPid()}|ConvertTo-Json -Compress
} catch {
 @{nativeEffectVerified=$false;guardVerified=$false;effectAttempted=[NxCoreConsole]::EffectAttempted;error=$_.Exception.Message}|ConvertTo-Json -Compress
}
`;

export class CoreNativeDenial extends Error {
  readonly code='CORE_NATIVE_DENIED';readonly effectAttempted=false;
  constructor(message:string){super(message);}
}

export async function runCorePowerShell(script:string,payload:unknown,signal?:AbortSignal,timeoutMs=30000):Promise<unknown>{
  if(process.platform!=='win32')throw new Error('WINDOWS_REQUIRED');
  if(signal?.aborted)throw new Error('CORE_REQUEST_CANCELLED');
  return await new Promise((resolve,reject)=>{
    const child=spawn(CORE_POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive','-STA','-Command',script],{
      cwd:'C:\\Windows\\System32',shell:false,windowsHide:true,env:windowsDpapiChildEnvironment(),stdio:['pipe','pipe','pipe']});
    let out='',err='',done=false,exitSeen:number|null|undefined;
    const cancel=()=>finish(new Error('CORE_NATIVE_CANCELLED_OR_UNKNOWN '+
      JSON.stringify({timeoutMs,stdoutBytes:out.length,stderrBytes:err.length,exitCode:exitSeen??null})));
    const timer=setTimeout(cancel,timeoutMs);
    function finish(error?:Error,value?:unknown){if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      if(error){child.kill();reject(error);}else resolve(value);}
    signal?.addEventListener('abort',cancel,{once:true});
    child.stdout.on('data',b=>{out+=b.toString('utf8');if(out.length>65536)finish(new Error('CORE_NATIVE_OUTPUT_LIMIT'));});
    child.stderr.on('data',b=>{err+=b.toString('utf8');if(err.length>16384)finish(new Error('CORE_NATIVE_ERROR_LIMIT'));});
    child.stdin.on('error',()=>{});child.on('error',e=>finish(e));
    child.once('exit',code=>{exitSeen=code;});
    child.on('close',code=>{if(code!==0){finish(new Error(err.slice(0,2048)||'CORE_NATIVE_DENIED'));return;}
      try{finish(undefined,JSON.parse(out.replace(/^\uFEFF/,'').trim()));}catch{finish(new Error('CORE_NATIVE_INVALID_RECEIPT'));}});
    child.stdin.end(JSON.stringify(payload));
  });
}
export async function executeCoreConsoleNative(capability:string,input:unknown,stopFile:string,signal:AbortSignal){
  const parsed=capability==='probe'?{}:parseCoreNativeInput(capability,input);
  const data=await runCorePowerShell(nativeScript,{capability,input:parsed,stopFile,agentPid:process.pid},signal,
    capability==='probe'?180000:30000);
  if(data&&typeof data==='object'&&'guardVerified' in data&&data.guardVerified===false&&
    'effectAttempted' in data&&data.effectAttempted===false)throw new CoreNativeDenial('CORE_NATIVE_GUARD_DENIED');
  if(!(data&&typeof data==='object'&&('nativeEffectVerified' in data&&data.nativeEffectVerified===true||
    capability==='probe'&&'guardVerified' in data&&data.guardVerified===true)))throw new Error('CORE_NATIVE_EFFECT_UNCONFIRMED');
  return {data};
}
