import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import {withPrivateDesktopProcessLock} from './windows-private-desktop-lock.js';
import {assertNoObviousPrivateShellBrokerInvocation,assertNoObviousPrivateShellScriptBrokerInvocation,isPrivateGuiBrokerExecutable} from './windows-private-shell-broker-guard.js';

const PRIVATE_DESKTOP_SYSTEM32='C:\\Windows\\System32';
const PRIVATE_DESKTOP_POWERSHELL=PRIVATE_DESKTOP_SYSTEM32+'\\WindowsPowerShell\\v1.0\\powershell.exe';
const PRIVATE_DESKTOP_MODULES=PRIVATE_DESKTOP_SYSTEM32+'\\WindowsPowerShell\\v1.0\\Modules';
/** Every internally launched host, GUI shell and helper uses a fixed system
 * interpreter. This environment is not used for arbitrary user-launched apps. */
export function privateDesktopPowerShellEnvironment():NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={
    SystemRoot:'C:\\Windows',windir:'C:\\Windows',
    ComSpec:PRIVATE_DESKTOP_SYSTEM32+'\\cmd.exe',
    PATH:PRIVATE_DESKTOP_SYSTEM32+';C:\\Windows',
    PSModulePath:PRIVATE_DESKTOP_MODULES,
  };
  for(const key of ['USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP'] as const){
    const value=process.env[key];
    if(!value||value.length>1024||!/^[A-Za-z]:\\/.test(value)||
       /[;"'\r\n\0]/.test(value)||value.split(/[\\/]/).includes('..'))continue;
    env[key]=value;
  }
  return env;
}

const DESKTOP_NAME = 'NexowirePrivate';
const StartSchema = z.object({ create_shortcut: z.boolean().default(true) });
const LaunchSchema = z.object({
  executable: z.string().min(1).max(4096),
  args: z.array(z.string().max(32_768)).max(128).default([]),
  cwd: z.string().max(4096).optional(),
});

const WindowHandleSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/);

const PrivatePointerMoveSchema = z.object({
  hwnd: WindowHandleSchema,
  x: z.number().int().min(0).max(32_767),
  y: z.number().int().min(0).max(32_767),
});

const PrivatePointerClickSchema =
  PrivatePointerMoveSchema.extend({
    button: z
      .enum(['left', 'right', 'middle'])
      .default('left'),
    clicks: z.number().int().min(1).max(3).default(1),
    control_hwnd:WindowHandleSchema.optional(),
    expected_class:z.string().min(1).max(256).optional(),
  }).refine(value=>(value.control_hwnd===undefined)===(value.expected_class===undefined),{
    message:'Provide control_hwnd and expected_class together for private child click.',
  });

const PrivatePointerScrollSchema=PrivatePointerMoveSchema.extend({
  axis:z.enum(['vertical','horizontal']).default('vertical'),
  delta:z.number().int().min(-1200).max(1200).refine(
    value=>value!==0&&value%120===0,
    {message:'Wheel delta must be a nonzero multiple of 120.'},
  ),
});

const PrivateWindowCloseSchema = z.object({
  hwnd: WindowHandleSchema,
});

const PrivateKeyboardTypeSchema = z.object({
  hwnd: WindowHandleSchema,
  text: z.string().min(1).max(20_000),
  interval_ms: z.number().int().min(0).max(100).default(0),
  x:z.number().int().min(0).max(32767).optional(),
  y:z.number().int().min(0).max(32767).optional(),
  control_hwnd:WindowHandleSchema.optional(),
  expected_class:z.string().min(1).max(256).optional(),
}).refine(value=>(value.x===undefined)===(value.y===undefined),{
  message:'Supply both x and y to target a private child control.',
}).refine(value=>(value.control_hwnd===undefined)===(value.expected_class===undefined),{
  message:'Supply both control_hwnd and expected_class from the control inventory.',
}).refine(value=>value.control_hwnd===undefined||value.x===undefined,{
  message:'Cannot combine exact child HWND and coordinate targeting.',
});

const PrivateKeyboardHotkeySchema = z.object({
  hwnd: WindowHandleSchema,
  keys: z
    .array(
      z
        .string()
        .min(1)
        .max(32)
        .transform((value) => value.trim().toUpperCase()),
    )
    .min(1)
    .max(8),
});

interface PrivateDesktopState {
  version: 1;
  desktopName: string;
  hostPid: number;
  shellPid: number;
  launchedPids: number[];
  startedAt: string;
}

class PrivateDesktopError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PrivateDesktopError';
  }
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new PrivateDesktopError(
      'WINDOWS_REQUIRED',
      'Nexowire private desktop requires Windows.',
    );
  }
}

function paths() {
  const root =
    process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR?.trim() ||
    path.join(os.homedir(), '.nexowire', 'private-desktop');
  return {
    root,
    state: path.join(root, 'state.json'),
    ready: path.join(root, 'ready.json'),
    shellPid: path.join(root, 'shell.pid'),
    host: path.join(root, 'host.ps1'),
    helper: path.join(root, 'helper.ps1'),
    inputHelper: path.join(root, 'input-helper.ps1'),
    shell: path.join(root, 'shell.ps1'),
    switcher: path.join(root, 'show.ps1'),
  };
}

function alive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID may still exist but the current account cannot
    // inspect it. Treat as alive; never discard a host/child on uncertainty.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitExit(pid: number, timeout = 4_000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (alive(pid) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

async function readState(): Promise<PrivateDesktopState | undefined> {
  let body: string;
  try {
    body=await fs.readFile(paths().state,'utf8');
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;
    throw error;
  }
  try {
    const value:unknown=JSON.parse(body);
    return z.object({
      version: z.literal(1),
      desktopName: z.literal(DESKTOP_NAME),
      hostPid: z.number().int().positive(),
      shellPid: z.number().int().positive(),
      launchedPids: z.array(z.number().int().positive()).max(1024),
      startedAt: z.string().min(1),
    }).parse(value) as PrivateDesktopState;
  }catch{
    // Corrupt/unknown state is not evidence that the prior desktop host
    // has stopped. Never delete it or launch a second host blindly.
    throw new PrivateDesktopError(
      'PRIVATE_DESKTOP_STATE_INVALID',
      'Private desktop state is malformed; refusing to replace a possibly live host.',
    );
  }
}

async function writeState(state: PrivateDesktopState): Promise<void> {
  const p = paths();
  await fs.mkdir(p.root, { recursive: true });
  const tmp = p.state + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, p.state);
}

const nativeSource = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NxDesktopNative {
  public const uint READ=0x0001, ENUM=0x0040, SWITCH=0x0100, UNICODE=0x400;
  public const int UOI_NAME=2;
  public const uint WM_KEYDOWN=0x0100, WM_KEYUP=0x0101, WM_CHAR=0x0102;
  public const uint WM_MOUSEMOVE=0x0200, WM_LBUTTONDOWN=0x0201, WM_LBUTTONUP=0x0202;
  public const uint WM_RBUTTONDOWN=0x0204, WM_RBUTTONUP=0x0205;
  public const uint WM_MBUTTONDOWN=0x0207, WM_MBUTTONUP=0x0208;
  public const uint WM_MOUSEWHEEL=0x020A, WM_MOUSEHWHEEL=0x020E;
  public const uint WM_CLOSE=0x0010;
  public const uint MK_LBUTTON=0x0001, MK_RBUTTON=0x0002, MK_MBUTTON=0x0010;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct SI {
    public int cb; public string reserved; public string desktop; public string title;
    public int x,y,xs,ys,xc,yc,fill,flags; public short show,cb2; public IntPtr r2,stdin,stdout,stderr;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
  public sealed class W { public string Hwnd; public string Title; public int ProcessId; public bool Visible; public int Left,Top,Right,Bottom; }
  public sealed class ChildControl { public string Hwnd,ClassName;public int ProcessId,Left,Top,Width,Height;public bool Visible,Enabled; }
  public sealed class ControlScan {public string Hwnd;public int ProcessId;public bool Truncated;public int ForeignProcessControlsSkipped;public ChildControl[] Controls;}
  delegate bool EnumProc(IntPtr hwnd, IntPtr l);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenDesktop(string n,int f,bool i,uint a);
  [DllImport("user32.dll",SetLastError=true)] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint f,bool i,uint a);
  [DllImport("user32.dll",SetLastError=true)] static extern bool EnumDesktopWindows(IntPtr h,EnumProc p,IntPtr l);
  [DllImport("user32.dll",SetLastError=true)] static extern bool EnumChildWindows(IntPtr h,EnumProc p,IntPtr l);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int cap);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll",SetLastError=true)] static extern bool GetClientRect(IntPtr h,out RECT r);
  [DllImport("user32.dll",SetLastError=true)] static extern bool ClientToScreen(IntPtr h,ref POINT p);
  [DllImport("user32.dll",SetLastError=true)] static extern bool ScreenToClient(IntPtr h,ref POINT p);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr ChildWindowFromPointEx(IntPtr h,POINT p,uint flags);
  const uint CWP_SKIPINVISIBLE=0x1,CWP_SKIPDISABLED=0x2,CWP_SKIPTRANSPARENT=0x4;
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
  [DllImport("user32.dll",SetLastError=true)] static extern bool PostMessage(IntPtr h,uint msg,UIntPtr w,IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr h,int i,StringBuilder b,int n,out int need);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static string Q(string v) {
    if (v==null) return "\"\"";
    if (v.Length>0 && v.IndexOfAny(new[]{' ','\t','\n','\v','\"'})<0) return v;
    var b=new StringBuilder(); b.Append('\"'); int s=0;
    foreach(char c in v){ if(c=='\\'){s++;continue;} if(c=='\"'){b.Append('\\',s*2+1);b.Append('\"');s=0;continue;} b.Append('\\',s);s=0;b.Append(c); }
    b.Append('\\',s*2); b.Append('\"'); return b.ToString();
  }
  static IntPtr H(string raw){
    if(String.IsNullOrWhiteSpace(raw))throw new InvalidOperationException("WINDOW_HANDLE_INVALID");
    long value=raw.StartsWith("0x",StringComparison.OrdinalIgnoreCase)?Convert.ToInt64(raw.Substring(2),16):Convert.ToInt64(raw,10);
    return new IntPtr(value);
  }
  static bool OnDesktop(string name,IntPtr target){
    var d=OpenDesktop(name,0,false,READ|ENUM);
    if(d==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try{
      bool found=false;
      EnumProc cb=delegate(IntPtr h,IntPtr _){if(h==target){found=true;return false;}return true;};
      EnumDesktopWindows(d,cb,IntPtr.Zero);
      return found;
    }finally{CloseDesktop(d);}
  }
  static IntPtr Target(string name,string raw){
    var h=H(raw);
    if(h==IntPtr.Zero)throw new InvalidOperationException("WINDOW_NOT_FOUND");
    if(!OnDesktop(name,h))throw new InvalidOperationException("WINDOW_NOT_PRIVATE_DESKTOP");
    return h;
  }
  static IntPtr XY(IntPtr h,int x,int y){
    RECT r;
    if(!GetClientRect(h,out r))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    var w=Math.Max(0,r.right-r.left);var hh=Math.Max(0,r.bottom-r.top);
    if(x<0||y<0||x>=w||y>=hh)throw new InvalidOperationException("POINT_OUTSIDE_CLIENT");
    long packed=((long)(ushort)y<<16)|(ushort)x;
    return new IntPtr(packed);
  }
  static void Post(IntPtr h,uint msg,UIntPtr w,IntPtr l){
    if(!PostMessage(h,msg,w,l))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
  public static string CloseWindow(string name,string raw){
    var h=Target(name,raw);
    Post(h,WM_CLOSE,UIntPtr.Zero,IntPtr.Zero);
    return "0x"+h.ToInt64().ToString("X");
  }
  public static string PointerMove(string name,string raw,int x,int y){
    var h=Target(name,raw);var l=XY(h,x,y);Post(h,WM_MOUSEMOVE,UIntPtr.Zero,l);return "0x"+h.ToInt64().ToString("X");
  }
  static IntPtr SafePrivateWheelChild(IntPtr top,POINT atScreen){
    // Top was validated via EnumDesktopWindows on NexowirePrivate.
    // Walk visible, enabled child controls without changing foreground,
    // physical cursor, or targeting another process's embedded window.
    uint ownerPid;
    GetWindowThreadProcessId(top,out ownerPid);
    IntPtr selected=top;
    for(int depth=0;depth<12;depth++){
      var inClient=atScreen;
      if(!ScreenToClient(selected,ref inClient))break;
      var candidate=ChildWindowFromPointEx(selected,inClient,
        CWP_SKIPINVISIBLE|CWP_SKIPDISABLED|CWP_SKIPTRANSPARENT);
      if(candidate==IntPtr.Zero||candidate==selected)break;
      uint childPid;
      GetWindowThreadProcessId(candidate,out childPid);
      if(childPid!=ownerPid)break;
      selected=candidate;
    }
    return selected;
  }
  public static string PointerScroll(string name,string raw,int x,int y,int delta,string axis){
    var h=Target(name,raw);
    XY(h,x,y); // validate private client coordinates without moving the real cursor
    var point=new POINT{x=x,y=y};
    if(!ClientToScreen(h,ref point))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    long packed=((long)(ushort)point.y<<16)|(ushort)point.x;
    uint wheel=(axis??"vertical").ToLowerInvariant()=="horizontal"
      ? WM_MOUSEHWHEEL:WM_MOUSEWHEEL;
    uint wp=unchecked((uint)(delta<<16));
    var privateTarget=SafePrivateWheelChild(h,point);
    Post(privateTarget,wheel,new UIntPtr(wp),new IntPtr(packed));
    return "0x"+h.ToInt64().ToString("X");
  }
  public static string PointerClick(string name,string raw,int x,int y,string button,int clicks,string childRaw,string expectedClass){
    var h=Target(name,raw);
    XY(h,x,y);
    // Translate validated private parent coordinates into a child-local
    // point, but only if that child belongs to the same target PID.
    // Never move the physical cursor, SetForegroundWindow or SendInput.
    var screen=new POINT{x=x,y=y};
    if(!ClientToScreen(h,ref screen))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    var target=SafePrivateWheelChild(h,screen);
    if(!String.IsNullOrEmpty(childRaw)){
      var exact=RequireExactChild(h,childRaw,expectedClass);
      if(target!=exact)throw new InvalidOperationException("PRIVATE_CHILD_CONTROL_POINT_MISMATCH");
    }
    var atTarget=screen;
    if(!ScreenToClient(target,ref atTarget))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    var l=XY(target,atTarget.x,atTarget.y);
    uint down,up,mask;
    switch((button??"left").ToLowerInvariant()){
      case "left":down=WM_LBUTTONDOWN;up=WM_LBUTTONUP;mask=MK_LBUTTON;break;
      case "right":down=WM_RBUTTONDOWN;up=WM_RBUTTONUP;mask=MK_RBUTTON;break;
      case "middle":down=WM_MBUTTONDOWN;up=WM_MBUTTONUP;mask=MK_MBUTTON;break;
      default:throw new InvalidOperationException("BUTTON_UNSUPPORTED");
    }
    Post(target,WM_MOUSEMOVE,UIntPtr.Zero,l);
    for(int i=0;i<clicks;i++){
      if(!String.IsNullOrEmpty(childRaw)){
        var exact=RequireExactChild(h,childRaw,expectedClass);
        if(SafePrivateWheelChild(h,screen)!=exact)
          throw new InvalidOperationException("PRIVATE_CHILD_CONTROL_POINT_MISMATCH");
      }
      Post(target,down,new UIntPtr(mask),l);
      Post(target,up,UIntPtr.Zero,l);
    }
    return "0x"+h.ToInt64().ToString("X");
  }
  static IntPtr RequireExactChild(IntPtr parent,string raw,string expectedClass){
    var child=H(raw);
    if(child==IntPtr.Zero||child==parent||!IsWindow(child)||!IsChild(parent,child))
      throw new InvalidOperationException("PRIVATE_CHILD_CONTROL_INVALID");
    uint parentPid,childPid;
    GetWindowThreadProcessId(parent,out parentPid);
    GetWindowThreadProcessId(child,out childPid);
    if(parentPid==0||childPid!=parentPid)
      throw new InvalidOperationException("PRIVATE_CHILD_CONTROL_INVALID");
    if(!IsWindowVisible(child)||!IsWindowEnabled(child))
      throw new InvalidOperationException("PRIVATE_CHILD_CONTROL_UNAVAILABLE");
    var actual=new StringBuilder(257);
    GetClassName(child,actual,actual.Capacity);
    if(!String.Equals(actual.ToString(),expectedClass,StringComparison.Ordinal))
      throw new InvalidOperationException("PRIVATE_CHILD_CONTROL_CLASS_MISMATCH");
    return child;
  }
  public static string Text(string name,string raw,string text,int intervalMs,
    bool childTarget,int x,int y,string childRaw,string expectedClass){
    var h=Target(name,raw);
    var sendTo=h;
    if(!String.IsNullOrEmpty(childRaw)){
      sendTo=RequireExactChild(h,childRaw,expectedClass);
    }else if(childTarget){
      XY(h,x,y);
      var point=new POINT{x=x,y=y};
      if(!ClientToScreen(h,ref point))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      // Never descend into cross-process child HWNDs.
      sendTo=SafePrivateWheelChild(h,point);
    }
    foreach(char ch in text??""){
      if(!String.IsNullOrEmpty(childRaw))
        RequireExactChild(h,childRaw,expectedClass);
      Post(sendTo,WM_CHAR,new UIntPtr((uint)ch),IntPtr.Zero);
      if(intervalMs>0)System.Threading.Thread.Sleep(intervalMs);
    }
    return "0x"+h.ToInt64().ToString("X");
  }
  public static string Hotkey(string name,string raw,int[] keys){
    var h=Target(name,raw);
    if(keys==null||keys.Length==0)throw new InvalidOperationException("HOTKEY_EMPTY");
    foreach(var key in keys)Post(h,WM_KEYDOWN,new UIntPtr((uint)key),IntPtr.Zero);
    for(int i=keys.Length-1;i>=0;i--)Post(h,WM_KEYUP,new UIntPtr((uint)keys[i]),IntPtr.Zero);
    return "0x"+h.ToInt64().ToString("X");
  }
  public static int Launch(string desktop,string exe,string[] args,string cwd){
    var p=new List<string>();p.Add(Q(exe));if(args!=null)foreach(var a in args)p.Add(Q(a??""));
    var si=new SI();si.cb=Marshal.SizeOf(typeof(SI));si.desktop="winsta0\\"+desktop;PI pi;
    if(!CreateProcess(exe,new StringBuilder(string.Join(" ",p)),IntPtr.Zero,IntPtr.Zero,false,UNICODE,IntPtr.Zero,String.IsNullOrWhiteSpace(cwd)?null:cwd,ref si,out pi)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try{return pi.pid;}finally{if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);}
  }
  public static long ValidatedWindow(string name,string raw){
    return Target(name,raw).ToInt64();
  }
  public static int ValidatedWindowProcessId(string name,string raw){
    var top=Target(name,raw);
    uint pid;
    GetWindowThreadProcessId(top,out pid);
    if(pid==0)throw new InvalidOperationException("PRIVATE_UIA_OWNER_UNKNOWN");
    return (int)pid;
  }
  public static int[] ClientOrigin(string name,string raw){
    var h=Target(name,raw);
    var p=new POINT{x=0,y=0};
    if(!ClientToScreen(h,ref p))
      throw new InvalidOperationException("PRIVATE_UIA_ORIGIN_UNAVAILABLE");
    return new int[]{p.x,p.y};
  }
  public static ControlScan Controls(string name,string raw){
    var top=Target(name,raw);
    uint owner;GetWindowThreadProcessId(top,out owner);
    var origin=new POINT{x=0,y=0};
    if(!ClientToScreen(top,ref origin))
      throw new InvalidOperationException("CONTROLS_ORIGIN_FAILED:"+Marshal.GetLastWin32Error());
    var result=new List<ChildControl>();
    var skipped=0;
    var scanned=0;
    var truncated=false;
    EnumProc visitor=delegate(IntPtr child,IntPtr _){
      scanned++;
      if(result.Count>=128||scanned>512){truncated=true;return false;}
      uint pid;GetWindowThreadProcessId(child,out pid);
      if(pid!=owner){skipped++;return true;}
      RECT r;if(!GetWindowRect(child,out r))return true;
      var cls=new StringBuilder(256);
      GetClassName(child,cls,cls.Capacity);
      result.Add(new ChildControl{
        Hwnd="0x"+child.ToInt64().ToString("X"),
        ProcessId=(int)pid,ClassName=cls.ToString(),
        Visible=IsWindowVisible(child),Enabled=IsWindowEnabled(child),
        Left=r.left-origin.x,Top=r.top-origin.y,
        Width=Math.Max(0,r.right-r.left),Height=Math.Max(0,r.bottom-r.top)
      });
      return true;
    };
    // Return false is expected when the bounded result reaches capacity.
    if(!EnumChildWindows(top,visitor,IntPtr.Zero)&&!truncated)
      throw new InvalidOperationException("CONTROLS_ENUM_FAILED:"+Marshal.GetLastWin32Error());
    return new ControlScan{
      Hwnd="0x"+top.ToInt64().ToString("X"),ProcessId=(int)owner,
      Truncated=truncated,ForeignProcessControlsSkipped=skipped,
      Controls=result.ToArray(),
    };
  }
  public static W[] Windows(string name){
    var d=OpenDesktop(name,0,false,READ|ENUM);if(d==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());var a=new List<W>();
    try{EnumProc cb=delegate(IntPtr h,IntPtr _){var len=Math.Min(GetWindowTextLength(h),4096);var s=new StringBuilder(len+1);GetWindowText(h,s,s.Capacity);uint pid;GetWindowThreadProcessId(h,out pid);RECT r;GetWindowRect(h,out r);a.Add(new W{Hwnd="0x"+h.ToInt64().ToString("X"),Title=s.ToString(),ProcessId=(int)pid,Visible=IsWindowVisible(h),Left=r.left,Top=r.top,Right=r.right,Bottom=r.bottom});return true;};if(!EnumDesktopWindows(d,cb,IntPtr.Zero))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());return a.ToArray();}finally{CloseDesktop(d);}
  }
  static string Name(IntPtr h){int need;GetUserObjectInformation(h,UOI_NAME,null,0,out need);if(need<=0)return "";var b=new StringBuilder(need/2+2);return GetUserObjectInformation(h,UOI_NAME,b,b.Capacity*2,out need)?b.ToString():"";}
  public static string Input(){var d=OpenInputDesktop(0,false,READ|SWITCH);if(d==IntPtr.Zero)return "";try{return Name(d);}finally{CloseDesktop(d);}}
}
`;

const hostScript = String.raw`
param([string]$Name,[string]$Ready,[string]$ShellPid)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public static class NxHost{
 public const uint R=1,CW=2,CM=4,H=8,E=0x40,W=0x80,S=0x100;
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateDesktop(string n,IntPtr d,IntPtr m,int f,uint a,IntPtr s);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr OpenDesktop(string n,int f,bool i,uint a);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool CloseDesktop(IntPtr h);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool SwitchDesktop(IntPtr h);
}
"@
$access=[NxHost]::R-bor[NxHost]::CW-bor[NxHost]::CM-bor[NxHost]::H-bor[NxHost]::E-bor[NxHost]::W-bor[NxHost]::S
$d=[NxHost]::CreateDesktop($Name,[IntPtr]::Zero,[IntPtr]::Zero,0,$access,[IntPtr]::Zero)
if($d-eq[IntPtr]::Zero){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
function Back{$x=[NxHost]::OpenDesktop('Default',0,$false,[NxHost]::S);if($x-ne[IntPtr]::Zero){try{[void][NxHost]::SwitchDesktop($x)}finally{[void][NxHost]::CloseDesktop($x)}}}
try{
 [pscustomobject]@{pid=$PID;name=$Name}|ConvertTo-Json -Compress|Set-Content -LiteralPath $Ready -Encoding UTF8
 $seen=$false
 while($true){if(Test-Path -LiteralPath $ShellPid){$raw=(Get-Content $ShellPid -Raw).Trim();$p=0;if([int]::TryParse($raw,[ref]$p)-and$p-gt 0){$seen=$true;if(-not(Get-Process -Id $p -ErrorAction SilentlyContinue)){Back;throw 'Private shell exited.'}}}elseif($seen){Back;throw 'Private shell state lost.'};Start-Sleep -Milliseconds 500}
}finally{Back;[void][NxHost]::CloseDesktop($d)}
`;

const helperScript = String.raw`
param([ValidateSet('launch','list','input')][string]$Action,[string]$Request)
$ErrorActionPreference='Stop';$r=Get-Content $Request -Raw|ConvertFrom-Json
Add-Type -TypeDefinition @"
${nativeSource}
"@
if ($Action -eq 'launch') {
  $a = @()
  if ($null -ne $r.args) {
    foreach ($x in $r.args) {
      $a += [string]$x
    }
  }
  $cwd = if ($r.cwd) { [string]$r.cwd } else { $null }
  $p = [NxDesktopNative]::Launch(
    [string]$r.desktop,
    [string]$r.executable,
    [string[]]$a,
    $cwd
  )
  [pscustomobject]@{ pid = $p } | ConvertTo-Json -Compress
  exit
}
if ($Action -eq 'input') {
  [pscustomobject]@{
    inputDesktop = [NxDesktopNative]::Input()
  } | ConvertTo-Json -Compress
  exit
}
$w = [NxDesktopNative]::Windows([string]$r.desktop)
[pscustomobject]@{
  windows = @(
    $w | ForEach-Object {
      [pscustomobject]@{
        hwnd = $_.Hwnd
        title = $_.Title
        processId = $_.ProcessId
        visible = $_.Visible
        rect = [pscustomobject]@{
          left = $_.Left
          top = $_.Top
          right = $_.Right
          bottom = $_.Bottom
          width = [Math]::Max(0, $_.Right - $_.Left)
          height = [Math]::Max(0, $_.Bottom - $_.Top)
        }
      }
    }
  )
  inputDesktop = [NxDesktopNative]::Input()
} | ConvertTo-Json -Depth 6 -Compress
`;

const inputHelperScript = String.raw`
param(
  [ValidateSet('pointer_move','pointer_click','pointer_scroll','controls','accessibility','accessibility_invoke_button','accessibility_set_edit_value','accessibility_set_checkbox','accessibility_select_radio','text','hotkey','close_window')]
  [string]$Action,
  [string]$Request,
  [string]$Response
)
$ErrorActionPreference='Stop'
$r=Get-Content $Request -Raw|ConvertFrom-Json
Add-Type -TypeDefinition @"
${nativeSource}
"@
try {
  $data = if ($Action -eq 'pointer_move') {
    $h=[NxDesktopNative]::PointerMove([string]$r.desktop,[string]$r.hwnd,[int]$r.x,[int]$r.y)
    [pscustomobject]@{hwnd=$h;x=[int]$r.x;y=[int]$r.y;inputDesktop=[NxDesktopNative]::Input()}
  } elseif ($Action -eq 'pointer_scroll') {
    $h=[NxDesktopNative]::PointerScroll([string]$r.desktop,[string]$r.hwnd,[int]$r.x,[int]$r.y,[int]$r.delta,[string]$r.axis)
    [pscustomobject]@{hwnd=$h;x=[int]$r.x;y=[int]$r.y;delta=[int]$r.delta;axis=[string]$r.axis;inputDesktop=[NxDesktopNative]::Input()}
  } elseif ($Action -eq 'pointer_click') {
    $h=[NxDesktopNative]::PointerClick([string]$r.desktop,[string]$r.hwnd,[int]$r.x,[int]$r.y,[string]$r.button,[int]$r.clicks,[string]$r.control_hwnd,[string]$r.expected_class)
    [pscustomobject]@{hwnd=$h;x=[int]$r.x;y=[int]$r.y;button=[string]$r.button;clicks=[int]$r.clicks;inputDesktop=[NxDesktopNative]::Input()}
  } elseif ($Action -eq 'controls') {
          $scan=[NxDesktopNative]::Controls([string]$r.desktop,[string]$r.hwnd)
      [pscustomobject]@{
        hwnd=$scan.Hwnd
        processId=$scan.ProcessId
        truncated=$scan.Truncated
        foreignProcessControlsSkipped=$scan.ForeignProcessControlsSkipped
        controls=@($scan.Controls|ForEach-Object{
          [pscustomobject]@{
            hwnd=$_.Hwnd;className=$_.ClassName;processId=$_.ProcessId
            visible=$_.Visible;enabled=$_.Enabled
            rect=[pscustomobject]@{
              left=$_.Left;top=$_.Top;width=$_.Width;height=$_.Height
            }
          }
        })
        inputDesktop=[NxDesktopNative]::Input()
      }
  } elseif ($Action -eq 'accessibility') {
    # UIA read-only subtree scan on a helper launched on NexowirePrivate.
    # Never enumerate RootElement/Default or request ValuePattern/TextPattern.
    $top=[IntPtr]([NxDesktopNative]::ValidatedWindow([string]$r.desktop,[string]$r.hwnd))
    $ownerPid=[NxDesktopNative]::ValidatedWindowProcessId([string]$r.desktop,[string]$r.hwnd)
    [int[]]$origin=[NxDesktopNative]::ClientOrigin([string]$r.desktop,[string]$r.hwnd)
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes -ErrorAction Stop
    $root=[System.Windows.Automation.AutomationElement]::FromHandle($top)
    if($null -eq $root){throw 'PRIVATE_UIA_ROOT_UNAVAILABLE'}
    $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
    $queue=New-Object 'System.Collections.Generic.Queue[object]'
    $queue.Enqueue([pscustomobject]@{element=$root;depth=0})
    $nodes=New-Object 'System.Collections.Generic.List[object]'
    $visited=0;$foreign=0;$skipped=0;$truncated=$false
    while($queue.Count -gt 0 -and $visited -lt 256 -and $nodes.Count -lt 128){
      $current=$queue.Dequeue()
      if([int]$current.depth -ge 5){continue}
      try {$child=$walker.GetFirstChild($current.element)}catch{$skipped++;continue}
      while($null -ne $child){
        $visited++
        if($visited -gt 256 -or $nodes.Count -ge 128){$truncated=$true;break}
        try{
          $c=$child.Current
          $nodePid=[int]$c.ProcessId
          if($nodePid -ne $ownerPid){$foreign++}
          else{
            $controlType=[string]$c.ControlType.ProgrammaticName
            $rect=$c.BoundingRectangle
            $validRect=(!$rect.IsEmpty -and ![double]::IsNaN($rect.X) -and ![double]::IsInfinity($rect.X) -and
              ![double]::IsNaN($rect.Y) -and ![double]::IsInfinity($rect.Y))
            $bounds=if($validRect){[pscustomobject]@{
              left=[int][math]::Round($rect.X-$origin[0]);top=[int][math]::Round($rect.Y-$origin[1]);
              width=[int][math]::Round([math]::Max(0,$rect.Width));
              height=[int][math]::Round([math]::Max(0,$rect.Height))
            }}else{$null}
            $name=''
            # Only safe action-label control types get Name metadata. Edit,
            # Text, Document and password contents must never be read.
            if(!$c.IsPassword -and $controlType -match '(Button|CheckBox|RadioButton|TabItem|MenuItem|Hyperlink)$'){
              $name=([string]$c.Name)
              if($name.Length -gt 128){$name=$name.Substring(0,128)}
            }
            $automationId=[string]$c.AutomationId
            if($automationId.Length -gt 128){$automationId=$automationId.Substring(0,128)}
            $className=[string]$c.ClassName
            if($className.Length -gt 128){$className=$className.Substring(0,128)}
            [void]$nodes.Add([pscustomobject]@{
              processId=$nodePid;depth=([int]$current.depth+1)
              controlType=$controlType;automationId=$automationId
              className=$className;actionLabel=$name
              enabled=[bool]$c.IsEnabled;offscreen=[bool]$c.IsOffscreen
              rect=$bounds
            })
            $queue.Enqueue([pscustomobject]@{element=$child;depth=([int]$current.depth+1)})
          }
        }catch{$skipped++}
        try{$child=$walker.GetNextSibling($child)}catch{$skipped++;break}
      }
    }
    if($queue.Count -gt 0 -or $visited -gt 256 -or $nodes.Count -ge 128){$truncated=$true}
    [pscustomobject]@{
      hwnd="0x"+$top.ToInt64().ToString("X")
      processId=$ownerPid
      nodes=@($nodes.ToArray())
      visited=$visited
      skipped=$skipped
      foreignProcessNodesSkipped=$foreign
      truncated=[bool]$truncated
      inputDesktop=[NxDesktopNative]::Input()
    }
  } elseif ($Action -in @('accessibility_invoke_button','accessibility_set_edit_value','accessibility_set_checkbox','accessibility_select_radio')) {
    $editMode=($Action -eq 'accessibility_set_edit_value')
    $checkboxMode=($Action -eq 'accessibility_set_checkbox')
    $radioMode=($Action -eq 'accessibility_select_radio')
    $wantedType=if($editMode){'ControlType.Edit'}elseif($checkboxMode){'ControlType.CheckBox'}elseif($radioMode){'ControlType.RadioButton'}else{'ControlType.Button'}
    # Explicit opt-in. Resolve, validate and invoke inside ONE private helper:
    # no RootElement, no physical focus/cursor, no generic cross-app UIA.
    $top=[IntPtr]([NxDesktopNative]::ValidatedWindow([string]$r.desktop,[string]$r.hwnd))
    $ownerPid=[NxDesktopNative]::ValidatedWindowProcessId([string]$r.desktop,[string]$r.hwnd)
    $wantedId=[string]$r.automation_id
    $wantedClass=[string]$r.expected_class
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes -ErrorAction Stop
    $root=[System.Windows.Automation.AutomationElement]::FromHandle($top)
    if($null -eq $root){throw 'PRIVATE_UIA_ROOT_UNAVAILABLE'}
    $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
    $queue=New-Object 'System.Collections.Generic.Queue[object]'
    $queue.Enqueue([pscustomobject]@{element=$root;depth=0})
    $matches=New-Object 'System.Collections.Generic.List[object]'
    $seen=0;$foreign=0;$skipped=0;$truncated=$false
    while($queue.Count -gt 0 -and $seen -lt 256){
      $entry=$queue.Dequeue()
      if([int]$entry.depth -ge 5){$truncated=$true;continue}
      try{$child=$walker.GetFirstChild($entry.element)}catch{$skipped++;continue}
      while($null -ne $child){
        $seen++
        if($seen -gt 256){$truncated=$true;break}
        try{
          $details=$child.Current
          if([int]$details.ProcessId -ne $ownerPid){$foreign++}
          else{
            if([string]$details.AutomationId -ceq $wantedId -and
              [string]$details.ControlType.ProgrammaticName -ceq $wantedType -and
              [string]$details.ClassName -ceq $wantedClass){
              [void]$matches.Add($child)
            }
            $queue.Enqueue([pscustomobject]@{element=$child;depth=([int]$entry.depth+1)})
          }
        }catch{$skipped++}
        try{$child=$walker.GetNextSibling($child)}catch{$skipped++;break}
      }
    }
    if($queue.Count -gt 0 -or $seen -gt 256){$truncated=$true}
    if($truncated -or $skipped -gt 0 -or $foreign -gt 0){throw 'PRIVATE_UIA_ACTION_INVENTORY_INCOMPLETE'}
    if($matches.Count -ne 1){throw 'PRIVATE_UIA_ACTION_NOT_UNIQUE'}
    $button=$matches[0]
    $verified=$button.Current
    if([int]$verified.ProcessId -ne $ownerPid -or
      [string]$verified.AutomationId -cne $wantedId -or
      [string]$verified.ClassName -cne $wantedClass -or
      [string]$verified.ControlType.ProgrammaticName -cne $wantedType -or
      !$verified.IsEnabled -or $verified.IsOffscreen -or $verified.IsPassword){
      throw 'PRIVATE_UIA_ACTION_TARGET_UNAVAILABLE'
    }
    $pattern=$null
    if($editMode){
      if(!$button.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){
        throw 'PRIVATE_UIA_VALUE_PATTERN_UNAVAILABLE'
      }
      $valuePattern=[System.Windows.Automation.ValuePattern]$pattern
      if($valuePattern.Current.IsReadOnly){throw 'PRIVATE_UIA_ACTION_TARGET_UNAVAILABLE'}
      # Never read ValuePattern.Current.Value or protected text.
      $valuePattern.SetValue([string]$r.value)
    }elseif($checkboxMode){
      if(!$button.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){
        throw 'PRIVATE_UIA_TOGGLE_PATTERN_UNAVAILABLE'
      }
      $toggle=[System.Windows.Automation.TogglePattern]$pattern
      $before=$toggle.Current.ToggleState
      if($before -eq [System.Windows.Automation.ToggleState]::Indeterminate){
        throw 'PRIVATE_UIA_CHECKBOX_INDETERMINATE'
      }
      $target=if([bool]$r.checked){[System.Windows.Automation.ToggleState]::On}else{[System.Windows.Automation.ToggleState]::Off}
      if($before -ne $target){$toggle.Toggle()}
      # Never blindly retry a toggle. A failed postcheck reports uncertainty.
      if($toggle.Current.ToggleState -ne $target){
        throw 'PRIVATE_UIA_CHECKBOX_POSTCONDITION_FAILED'
      }
    }elseif($radioMode){
      if(!$button.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){
        throw 'PRIVATE_UIA_SELECTION_ITEM_PATTERN_UNAVAILABLE'
      }
      $selection=[System.Windows.Automation.SelectionItemPattern]$pattern
      # Only the element's own IsSelected is queried, never sibling labels or values.
      if(!$selection.Current.IsSelected){$selection.Select()}
      if(!$selection.Current.IsSelected){throw 'PRIVATE_UIA_RADIO_POSTCONDITION_FAILED'}
    }else{
      if(!$button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){
        throw 'PRIVATE_UIA_INVOKE_PATTERN_UNAVAILABLE'
      }
      ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
    }
    [pscustomobject]@{
      hwnd="0x"+$top.ToInt64().ToString("X")
      processId=$ownerPid
      automationId=$wantedId
      controlType=$wantedType
      actionCompleted=$true
      inputDesktop=[NxDesktopNative]::Input()
    }
  } elseif ($Action -eq 'close_window') {
    $h=[NxDesktopNative]::CloseWindow([string]$r.desktop,[string]$r.hwnd)
    [pscustomobject]@{hwnd=$h;inputDesktop=[NxDesktopNative]::Input();closeRequested=$true}
  } elseif ($Action -eq 'text') {
    $hasXY=($null-ne$r.x)-and($null-ne$r.y)
    $h=[NxDesktopNative]::Text([string]$r.desktop,[string]$r.hwnd,[string]$r.text,[int]$r.interval_ms,[bool]$hasXY,[int]$r.x,[int]$r.y,[string]$r.control_hwnd,[string]$r.expected_class)
    [pscustomobject]@{hwnd=$h;charsSent=([string]$r.text).Length;intervalMs=[int]$r.interval_ms;inputDesktop=[NxDesktopNative]::Input()}
  } else {
    [int[]]$keys=@($r.virtualKeys|ForEach-Object{[int]$_})
    $h=[NxDesktopNative]::Hotkey([string]$r.desktop,[string]$r.hwnd,$keys)
    [pscustomobject]@{hwnd=$h;keyCount=$keys.Length;inputDesktop=[NxDesktopNative]::Input()}
  }
  $json=[pscustomobject]@{ok=$true;data=$data}|ConvertTo-Json -Depth 6 -Compress
  [IO.File]::WriteAllText($Response,$json,(New-Object Text.UTF8Encoding($false)))
} catch {
  $message=$_.Exception.Message
  $code='PRIVATE_INPUT_FAILED'
  foreach($candidate in @('WINDOW_NOT_PRIVATE_DESKTOP','WINDOW_NOT_FOUND','POINT_OUTSIDE_CLIENT','PRIVATE_CHILD_CONTROL_INVALID','PRIVATE_CHILD_CONTROL_UNAVAILABLE','PRIVATE_CHILD_CONTROL_CLASS_MISMATCH','PRIVATE_CHILD_CONTROL_POINT_MISMATCH','BUTTON_UNSUPPORTED','HOTKEY_EMPTY')){
    if($message.Contains($candidate)){$code=$candidate;break}
  }
  $json=[pscustomobject]@{ok=$false;code=$code;message=$message}|ConvertTo-Json -Compress
  [IO.File]::WriteAllText($Response,$json,(New-Object Text.UTF8Encoding($false)))
  exit 1
}
`;

const shellScript = String.raw`
$ErrorActionPreference='Stop';Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;public static class NxBack{public const uint S=0x100;[DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern IntPtr OpenDesktop(string n,int f,bool i,uint a);[DllImport("user32.dll")]static extern bool SwitchDesktop(IntPtr h);[DllImport("user32.dll")]static extern bool CloseDesktop(IntPtr h);public static void Go(){var d=OpenDesktop("Default",0,false,S);if(d==IntPtr.Zero)return;try{SwitchDesktop(d);}finally{CloseDesktop(d);}}}
"@
$w=New-Object Windows.Window;$w.Title='Nexowire Private Desktop';$w.WindowStyle='None';$w.ResizeMode='NoResize';$w.WindowState='Maximized';$w.Background=[Windows.Media.BrushConverter]::new().ConvertFromString('#101218');$w.Foreground='White';$w.ShowInTaskbar=$false
$s=New-Object Windows.Controls.StackPanel;$s.Margin='42';$w.Content=$s
$t=New-Object Windows.Controls.TextBlock;$t.Text='NEXOWIRE PRIVATE DESKTOP';$t.FontSize=28;$t.FontWeight='Bold';$t.Margin='0,0,0,10';[void]$s.Children.Add($t)
$b=New-Object Windows.Controls.TextBlock;$b.Text='Isolated GUI workspace. Private input stays here unless console access is explicitly granted.';$b.FontSize=15;$b.Opacity=.8;$b.MaxWidth=760;$b.TextWrapping='Wrap';$b.Margin='0,0,0,24';[void]$s.Children.Add($b)
$r=New-Object Windows.Controls.Button;$r.Content='RETURN TO MY DESKTOP';$r.Padding='18,10,18,10';$r.HorizontalAlignment='Left';$r.Add_Click({[NxBack]::Go()});[void]$s.Children.Add($r)
$h=New-Object Windows.Controls.TextBlock;$h.Text='Failsafe: Ctrl+Alt+D also returns.';$h.Opacity=.6;$h.Margin='0,12,0,0';[void]$s.Children.Add($h)
$w.Add_KeyDown({param($sender,$e);$c=[Windows.Input.Keyboard]::IsKeyDown([Windows.Input.Key]::LeftCtrl)-or[Windows.Input.Keyboard]::IsKeyDown([Windows.Input.Key]::RightCtrl);$a=[Windows.Input.Keyboard]::IsKeyDown([Windows.Input.Key]::LeftAlt)-or[Windows.Input.Keyboard]::IsKeyDown([Windows.Input.Key]::RightAlt);if($c-and$a-and$e.Key-eq[Windows.Input.Key]::D){[NxBack]::Go();$e.Handled=$true}});[void]$w.ShowDialog()
`;

const switchScript = String.raw`
$ErrorActionPreference='Stop';Add-Type -AssemblyName PresentationFramework
Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;public static class NxGo{public const uint S=0x100;[DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern IntPtr OpenDesktop(string n,int f,bool i,uint a);[DllImport("user32.dll")]static extern bool SwitchDesktop(IntPtr h);[DllImport("user32.dll")]static extern bool CloseDesktop(IntPtr h);public static bool Go(){var d=OpenDesktop("NexowirePrivate",0,false,S);if(d==IntPtr.Zero)return false;try{return SwitchDesktop(d);}finally{CloseDesktop(d);}}}
"@
if(-not[NxGo]::Go()){[Windows.MessageBox]::Show('Nexowire Private Desktop is not running.','Nexowire')|Out-Null;exit 2}
[pscustomobject]@{ok=$true;desktop='NexowirePrivate'}|ConvertTo-Json -Compress
`;

async function ensureScripts(): Promise<void> {
  const p = paths();
  await fs.mkdir(p.root, { recursive: true });
  await Promise.all([
    fs.writeFile(p.host, hostScript, 'utf8'),
    fs.writeFile(p.helper, helperScript, 'utf8'),
    fs.writeFile(p.inputHelper, inputHelperScript, 'utf8'),
    fs.writeFile(p.shell, shellScript, 'utf8'),
    fs.writeFile(p.switcher, switchScript, 'utf8'),
  ]);
}

async function psJson(args: string[], timeout = 15_000): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const child = spawn(PRIVATE_DESKTOP_POWERSHELL, ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',...args], { windowsHide:true,shell:false,cwd:PRIVATE_DESKTOP_SYSTEM32,env:privateDesktopPowerShellEnvironment(),stdio:['ignore','pipe','pipe'] });
    const out: Buffer[]=[]; const err: Buffer[]=[]; let bytes=0;
    const collect=(a:Buffer[],c:Buffer)=>{bytes+=c.length;if(bytes<=2*1024*1024)a.push(c);};
    child.stdout.on('data',(c:Buffer)=>collect(out,c));child.stderr.on('data',(c:Buffer)=>collect(err,c));
    const timer=setTimeout(()=>{child.kill();reject(new PrivateDesktopError('HELPER_TIMEOUT','Private desktop helper timed out.'));},timeout);
    child.once('error',(e)=>{clearTimeout(timer);reject(new PrivateDesktopError('HELPER_START_FAILED','Failed to start private desktop helper.',{nativeMessage:e.message}));});
    child.once('exit',(code)=>{clearTimeout(timer);const o=Buffer.concat(out).toString('utf8').trim();const e=Buffer.concat(err).toString('utf8').trim();if(code!==0){reject(new PrivateDesktopError('HELPER_FAILED',e||o||'Private desktop helper failed.',{exitCode:code}));return;}if(!o){resolve({});return;}try{resolve(JSON.parse(o));}catch{reject(new PrivateDesktopError('HELPER_OUTPUT_INVALID','Private desktop helper returned invalid JSON.',{outputPreview:o.slice(0,2048)}));}});
  });
}

type PrivateDesktopHelperAction =
  | 'launch'
  | 'list'
  | 'input';

type PrivateInputAction =
  | 'pointer_move'
  | 'pointer_click'
  | 'pointer_scroll'
  | 'controls'
  | 'accessibility'
  | 'accessibility_invoke_button'
  | 'accessibility_set_edit_value'
  | 'accessibility_set_checkbox'
  | 'accessibility_select_radio'
  | 'text'
  | 'hotkey'
  | 'close_window';

async function request(action:PrivateDesktopHelperAction, payload:Record<string,unknown>):Promise<unknown>{
  const p=paths();const f=path.join(p.root,'req-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(16).slice(2)+'.json');await fs.writeFile(f,JSON.stringify(payload),'utf8');
  try{return await psJson(['-File',p.helper,'-Action',action,'-Request',f]);}finally{await fs.rm(f,{force:true});}
}

async function privateInputRequest(
  action: PrivateInputAction,
  payload: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<unknown> {
  const p = paths();
  const nonce =
    process.pid +
    '-' +
    Date.now() +
    '-' +
    Math.random().toString(16).slice(2);
  const requestFile = path.join(
    p.root,
    'private-input-' + nonce + '.request.json',
  );
  const responseFile = path.join(
    p.root,
    'private-input-' + nonce + '.response.json',
  );
  await fs.writeFile(
    requestFile,
    JSON.stringify(payload),
    'utf8',
  );

  let pid: number | undefined;
  try {
    pid = await launch(
      PRIVATE_DESKTOP_POWERSHELL,
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        p.inputHelper,
        '-Action',
        action,
        '-Request',
        requestFile,
        '-Response',
        responseFile,
      ],
      p.root,
    );

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = (
          await fs.readFile(responseFile, 'utf8')
        ).replace(/^\uFEFF/, '');
        const envelope = z
          .object({
            ok: z.boolean(),
            data: z.unknown().optional(),
            code: z.string().optional(),
            message: z.string().optional(),
          })
          .parse(JSON.parse(raw));
        if (!envelope.ok) {
          throw new PrivateDesktopError(
            envelope.code ?? 'PRIVATE_INPUT_FAILED',
            envelope.message ??
              'Private desktop input helper failed.',
          );
        }
        return envelope.data ?? {};
      } catch (error) {
        if (
          error instanceof PrivateDesktopError
        ) {
          throw error;
        }
        if (!alive(pid)) {
          throw new PrivateDesktopError(
            'PRIVATE_INPUT_HELPER_EXITED',
            'Private desktop input helper exited before producing a valid response.',
          );
        }
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 25),
      );
    }

    throw new PrivateDesktopError(
      'PRIVATE_INPUT_TIMEOUT',
      'Private desktop input helper timed out.',
    );
  } finally {
    if (pid && alive(pid)) {
      await killTree(pid).catch(() => undefined);
    }
    await Promise.all([
      fs.rm(requestFile, { force: true }),
      fs.rm(responseFile, { force: true }),
    ]);
  }
}

async function resolveExecutable(executable: string): Promise<string> {
  const raw = executable.trim();
  if (!raw) {
    throw new PrivateDesktopError(
      'EXECUTABLE_REQUIRED',
      'Private desktop executable cannot be empty.',
    );
  }

  const hasPath =
    path.isAbsolute(raw) ||
    raw.includes('\\') ||
    raw.includes('/');
  const candidates: string[] = [];

  if (hasPath) {
    candidates.push(path.resolve(raw));
  } else {
    const searchPath = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const extension = path.extname(raw);
    const extensions = extension
      ? ['']
      : (process.env.PATHEXT ?? '.EXE;.COM')
          .split(';')
          .map((entry) => entry.trim())
          .filter(Boolean);

    for (const directory of searchPath) {
      for (const suffix of extensions) {
        candidates.push(path.join(directory, raw + suffix));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Keep searching the bounded PATH candidate set.
    }
  }

  throw new PrivateDesktopError(
    'EXECUTABLE_NOT_FOUND',
    'Private desktop executable was not found on the native-agent PATH.',
    { executable: raw },
  );
}

/**
 * These Windows launchers may forward activation to an existing Explorer,
 * COM or shell broker on the user's Default/Secure Desktop. Assigning
 * STARTUPINFO.lpDesktop to the immediate CreateProcess child alone does
 * not isolate their GUI and elevation descendants.
 *
 * Block known broker entry points, not all applications. Scripted
 * ShellExecute/COM children are not yet fully contained by this check.
 */
export function assertNoPrivateDesktopBrokeredExecutable(
  executable:string,
):void{
  const name=path.win32.basename(executable.trim()
    .replace(/^["']|["']$/g,'')).toLowerCase();
  if(!isPrivateGuiBrokerExecutable(executable))return;
  throw new PrivateDesktopError(
    'PRIVATE_DESKTOP_SHELL_BROKER_UNISOLATED',
    'This Windows shell/COM/installer broker may create windows on the '+
    'owner Default or Secure Desktop. Use a directly executable private '+
    'GUI application or an isolated guest session instead.',
    {executable:name},
  );
}

async function launch(
  executable: string,
  args: string[],
  cwd?: string,
): Promise<number> {
  assertNoPrivateDesktopBrokeredExecutable(executable);
  // A directly attached PowerShell/CMD child can still dispatch GUI to
  // Explorer/COM via its command string, bypassing the executable denylist.
  // Apply the same bounded command guard used by the private shell workers.
  await assertNoObviousPrivateShellScriptBrokerInvocation(executable,args,cwd);
  const resolvedExecutable = await resolveExecutable(executable);
  assertNoPrivateDesktopBrokeredExecutable(resolvedExecutable);
  await assertNoObviousPrivateShellScriptBrokerInvocation(resolvedExecutable,args,cwd);
  return z
    .object({ pid: z.number().int().positive() })
    .parse(
      await request('launch', {
        desktop: DESKTOP_NAME,
        executable: resolvedExecutable,
        args,
        ...(cwd ? { cwd } : {}),
      }),
    ).pid;
}

const WindowSchema=z.object({hwnd:z.string(),title:z.string(),processId:z.number().int().nonnegative(),visible:z.boolean(),rect:z.object({left:z.number().int(),top:z.number().int(),right:z.number().int(),bottom:z.number().int(),width:z.number().int().nonnegative(),height:z.number().int().nonnegative()})});
async function view(){return z.object({windows:z.array(WindowSchema).max(4096),inputDesktop:z.string().max(256)}).parse(await request('list',{desktop:DESKTOP_NAME}));}
const ControlScanSchema=z.object({
  hwnd:WindowHandleSchema,
  processId:z.number().int().nonnegative(),
  truncated:z.boolean(),
  foreignProcessControlsSkipped:z.number().int().nonnegative(),
  controls:z.array(z.object({
    hwnd:WindowHandleSchema,
    className:z.string().max(256),
    processId:z.number().int().nonnegative(),
    visible:z.boolean(),enabled:z.boolean(),
    rect:z.object({
      left:z.number().int(),top:z.number().int(),
      width:z.number().int().nonnegative(),height:z.number().int().nonnegative(),
    }),
  })).max(128),
  inputDesktop:z.string().max(256),
});
const AccessibilityScanSchema=z.object({
  hwnd:WindowHandleSchema,
  processId:z.number().int().nonnegative(),
  nodes:z.array(z.object({
    processId:z.number().int().nonnegative(),
    depth:z.number().int().min(1).max(5),
    controlType:z.string().max(128),
    automationId:z.string().max(128),
    className:z.string().max(128),
    actionLabel:z.string().max(128),
    enabled:z.boolean(),offscreen:z.boolean(),
    rect:z.object({
      left:z.number().int(),top:z.number().int(),
      width:z.number().int().nonnegative(),height:z.number().int().nonnegative(),
    }).nullable(),
  })).max(128),
  visited:z.number().int().min(0).max(257),
  skipped:z.number().int().nonnegative(),
  foreignProcessNodesSkipped:z.number().int().nonnegative(),
  truncated:z.boolean(),inputDesktop:z.string().max(256),
});

async function inputDesktop():Promise<string>{return z.object({inputDesktop:z.string().max(256)}).parse(await request('input',{desktop:DESKTOP_NAME})).inputDesktop;}

async function shortcut():Promise<string|null>{
  if(process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT==='1')return null;const p=paths();const app=process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming');const dir=path.join(app,'Microsoft','Windows','Start Menu','Programs');const link=path.join(dir,'Nexowire Private Desktop.lnk');await fs.mkdir(dir,{recursive:true});
  const f=path.join(p.root,'shortcut-'+process.pid+'.ps1');const q=(v:string)=>v.replace(/'/g,"''");const s=["$ErrorActionPreference='Stop'","$w=New-Object -ComObject WScript.Shell","$s=$w.CreateShortcut('"+q(link)+"')","$s.TargetPath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'","$s.Arguments='-NoLogo -NoProfile -ExecutionPolicy Bypass -File \""+q(p.switcher)+"\"'","$s.WorkingDirectory=[Environment]::GetFolderPath('UserProfile')","$s.Description='Open Nexowire Private Desktop'","$s.Hotkey='CTRL+ALT+N'",'$s.Save()'].join('\n');await fs.writeFile(f,s,'utf8');try{await psJson(['-File',f]);}finally{await fs.rm(f,{force:true});}return link;
}

async function start(input:unknown):Promise<{data:unknown}>{
  assertWindows();const parsed=StartSchema.parse(input);await ensureScripts();const p=paths();const old=await readState();if(old&&alive(old.hostPid)&&alive(old.shellPid))return{data:{running:true,reused:true,desktopName:DESKTOP_NAME,hostPid:old.hostPid,shellPid:old.shellPid,inputDesktop:await inputDesktop(),visibleDesktopChanged:false}};
  // If any persisted PID remains alive, replacing the state would orphan
  // its GUI process and discard the sole cleanup/stop bookkeeping.
  if(old&&[old.hostPid,old.shellPid,...old.launchedPids].some(alive)){
    throw new PrivateDesktopError(
      'PRIVATE_DESKTOP_PARTIAL_HOST',
      'Private desktop host is partially running; refusing unsafe restart.',
    );
  }
  await Promise.all([fs.rm(p.state,{force:true}),fs.rm(p.ready,{force:true}),fs.rm(p.shellPid,{force:true})]);const host=spawn(PRIVATE_DESKTOP_POWERSHELL,['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',p.host,'-Name',DESKTOP_NAME,'-Ready',p.ready,'-ShellPid',p.shellPid],{detached:false,windowsHide:true,shell:false,cwd:p.root,env:privateDesktopPowerShellEnvironment(),stdio:'ignore'});if(!host.pid)throw new PrivateDesktopError('HOST_START_FAILED','No PID for private desktop host.');host.unref();
  const end=Date.now()+8000;let ready=false;while(Date.now()<end){if(!alive(host.pid))break;try{await fs.access(p.ready);ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}if(!ready){if(alive(host.pid))process.kill(host.pid);throw new PrivateDesktopError('NOT_READY','Private desktop host did not become ready.');}
  let shellPid:number|undefined;try{shellPid=await launch(PRIVATE_DESKTOP_POWERSHELL,['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',p.shell],p.root);await fs.writeFile(p.shellPid,String(shellPid)+'\n','utf8');await new Promise(r=>setTimeout(r,800));if(!alive(shellPid))throw new PrivateDesktopError('SHELL_START_FAILED','Private desktop shell exited during startup.');const state:PrivateDesktopState={version:1,desktopName:DESKTOP_NAME,hostPid:host.pid,shellPid,launchedPids:[],startedAt:new Date().toISOString()};await writeState(state);const link=parsed.create_shortcut?await shortcut():null;const v=await view();return{data:{running:true,reused:false,desktopName:DESKTOP_NAME,hostPid:host.pid,shellPid,windowCount:v.windows.length,inputDesktop:v.inputDesktop,visibleDesktopChanged:false,shortcut:link,manualSwitchHotkey:link?'Ctrl+Alt+N':null}};}catch(e){if(shellPid&&alive(shellPid)){try{process.kill(shellPid);await waitExit(shellPid);}catch{}}if(alive(host.pid)){try{process.kill(host.pid);await waitExit(host.pid);}catch{}}await Promise.all([fs.rm(p.state,{force:true}),fs.rm(p.shellPid,{force:true}),fs.rm(p.ready,{force:true})]);throw e;}
}

async function killTree(pid:number):Promise<void>{if(!alive(pid))return;await new Promise<void>(resolve=>{const c=spawn('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});c.once('error',()=>resolve());c.once('exit',()=>resolve());});await waitExit(pid);}
async function stop():Promise<{data:unknown}>{assertWindows();const p=paths();const s=await readState();if(!s)return{data:{running:false,stopped:false,desktopName:DESKTOP_NAME}};for(const pid of [...s.launchedPids].reverse())await killTree(pid);await killTree(s.shellPid);if(alive(s.hostPid)){try{process.kill(s.hostPid);}catch{}if(!(await waitExit(s.hostPid)))throw new PrivateDesktopError('HOST_STOP_NOT_VERIFIED','Private desktop host did not exit.',{pid:s.hostPid});}await Promise.all([fs.rm(p.state,{force:true}),fs.rm(p.shellPid,{force:true}),fs.rm(p.ready,{force:true})]);return{data:{running:false,stopped:true,desktopName:DESKTOP_NAME,inputDesktop:await inputDesktop().catch(()=> '')}};}
async function launchApp(input:unknown):Promise<{data:unknown}>{assertWindows();const p=LaunchSchema.parse(input);const s=await readState();if(!s||!alive(s.hostPid)||!alive(s.shellPid))throw new PrivateDesktopError('NOT_RUNNING','Start the private desktop first.');const pid=await launch(p.executable,p.args,p.cwd);await writeState({...s,launchedPids:[...new Set([...s.launchedPids,pid])].slice(-1024)});return{data:{pid,desktopName:DESKTOP_NAME,visibleDesktopChanged:false}};}
async function status():Promise<{data:unknown}>{assertWindows();const s=await readState();if(!s||!alive(s.hostPid)||!alive(s.shellPid))return{data:{running:false,desktopName:DESKTOP_NAME,inputDesktop:await inputDesktop().catch(()=>''),visibleDesktopChanged:false}};let v:Awaited<ReturnType<typeof view>>|undefined;try{v=await view();}catch{}return{data:{running:true,desktopName:DESKTOP_NAME,hostPid:s.hostPid,shellPid:s.shellPid,launchedPids:s.launchedPids.filter(alive),startedAt:s.startedAt,inputDesktop:v?.inputDesktop??(await inputDesktop().catch(()=>'')),windowCount:v?.windows.length??null,visibleDesktopChanged:false}};}
async function accessibility(input:unknown):Promise<{data:unknown}>{
  assertWindows();
  const parsed=z.object({hwnd:WindowHandleSchema}).strict().parse(input);
  const s=await readState();
  if(!s||!alive(s.hostPid)||!alive(s.shellPid))
    throw new PrivateDesktopError('NOT_RUNNING','Private desktop is not running.');
  const result=AccessibilityScanSchema.parse(await privateInputRequest(
    'accessibility',{desktop:DESKTOP_NAME,hwnd:parsed.hwnd},20_000,
  ));
  return{data:{...result,desktopName:DESKTOP_NAME,
    observationScope:'PRIVATE_WINDOW_UIA_CONTROL_VIEW',
    exposesTextValues:false,physicalDesktopInspected:false,
    visibleDesktopChanged:false,accessibilityCoverageComplete:false}};
}
const PrivateUiaInvokeButtonSchema=z.object({
  hwnd:WindowHandleSchema,
  automation_id:z.string().min(1).max(128),
  expected_class:z.string().min(1).max(128),
}).strict();

async function invokePrivateUiaButton(input:unknown):Promise<{data:unknown}>{
  assertWindows();
  await requireRunningPrivateDesktop();
  const parsed=PrivateUiaInvokeButtonSchema.parse(input);
  try{
    const result=z.object({
      hwnd:WindowHandleSchema,
      processId:z.number().int().positive(),
      automationId:z.string().min(1).max(128),
      controlType:z.literal('ControlType.Button'),
      actionCompleted:z.literal(true),
      inputDesktop:z.string().max(256),
    }).parse(await privateInputRequest('accessibility_invoke_button',{
      desktop:DESKTOP_NAME,hwnd:parsed.hwnd,
      automation_id:parsed.automation_id,
      expected_class:parsed.expected_class,
    },25_000));
    return{data:{...result,invoked:true,desktopName:DESKTOP_NAME,
      touchesSystemCursor:false,touchesSystemKeyboard:false,
      visibleDesktopChanged:false,
      actionScope:'EXPLICIT_SAME_PROCESS_PRIVATE_BUTTON_UIA_INVOKE'}};
  }catch(error){return remapPrivateInputError(error);}
}
const PrivateUiaSetEditValueSchema=z.object({
  hwnd:WindowHandleSchema,
  automation_id:z.string().min(1).max(128),
  expected_class:z.string().min(1).max(128),
  value:z.string().max(4000),
}).strict();

async function setPrivateUiaEditValue(input:unknown):Promise<{data:unknown}>{
  assertWindows();
  await requireRunningPrivateDesktop();
  const parsed=PrivateUiaSetEditValueSchema.parse(input);
  try{
    const result=z.object({
      hwnd:WindowHandleSchema,
      processId:z.number().int().positive(),
      automationId:z.string().min(1).max(128),
      controlType:z.literal('ControlType.Edit'),
      actionCompleted:z.literal(true),
      inputDesktop:z.string().max(256),
    }).parse(await privateInputRequest('accessibility_set_edit_value',{
      desktop:DESKTOP_NAME,hwnd:parsed.hwnd,
      automation_id:parsed.automation_id,
      expected_class:parsed.expected_class,
      value:parsed.value,
    },25_000));
    return{data:{...result,desktopName:DESKTOP_NAME,
      touchesSystemCursor:false,touchesSystemKeyboard:false,
      systemClipboardTouched:false,
      visibleDesktopChanged:false,
      actionScope:'EXPLICIT_SAME_PROCESS_PRIVATE_UIA_EDIT_SETVALUE'}};
  }catch(error){return remapPrivateInputError(error);}
}
const PrivateUiaSetCheckboxSchema=z.object({
  hwnd:WindowHandleSchema,
  automation_id:z.string().min(1).max(128),
  expected_class:z.string().min(1).max(128),
  checked:z.boolean(),
}).strict();

async function setPrivateUiaCheckbox(input:unknown):Promise<{data:unknown}>{
  assertWindows();
  await requireRunningPrivateDesktop();
  const parsed=PrivateUiaSetCheckboxSchema.parse(input);
  try{
    const result=z.object({
      hwnd:WindowHandleSchema,
      processId:z.number().int().positive(),
      automationId:z.string().min(1).max(128),
      controlType:z.literal('ControlType.CheckBox'),
      actionCompleted:z.literal(true),
      inputDesktop:z.string().max(256),
    }).parse(await privateInputRequest('accessibility_set_checkbox',{
      desktop:DESKTOP_NAME,hwnd:parsed.hwnd,
      automation_id:parsed.automation_id,
      expected_class:parsed.expected_class,
      checked:parsed.checked,
    },25_000));
    return{data:{...result,checked:parsed.checked,desktopName:DESKTOP_NAME,
      touchesSystemCursor:false,touchesSystemKeyboard:false,
      systemClipboardTouched:false,visibleDesktopChanged:false,
      actionScope:'EXPLICIT_SAME_PROCESS_PRIVATE_UIA_CHECKBOX_SET'}};
  }catch(error){return remapPrivateInputError(error);}
}
const PrivateUiaSelectRadioSchema=z.object({
  hwnd:WindowHandleSchema,
  automation_id:z.string().min(1).max(128),
  expected_class:z.string().min(1).max(128),
}).strict();

async function selectPrivateUiaRadio(input:unknown):Promise<{data:unknown}>{
  assertWindows();
  await requireRunningPrivateDesktop();
  const parsed=PrivateUiaSelectRadioSchema.parse(input);
  try{
    const result=z.object({
      hwnd:WindowHandleSchema,
      processId:z.number().int().positive(),
      automationId:z.string().min(1).max(128),
      controlType:z.literal('ControlType.RadioButton'),
      actionCompleted:z.literal(true),
      inputDesktop:z.string().max(256),
    }).parse(await privateInputRequest('accessibility_select_radio',{
      desktop:DESKTOP_NAME,hwnd:parsed.hwnd,
      automation_id:parsed.automation_id,
      expected_class:parsed.expected_class,
    },25_000));
    return{data:{...result,selected:true,desktopName:DESKTOP_NAME,
      touchesSystemCursor:false,touchesSystemKeyboard:false,
      systemClipboardTouched:false,visibleDesktopChanged:false,
      actionScope:'EXPLICIT_SAME_PROCESS_PRIVATE_UIA_RADIO_SELECT'}};
  }catch(error){return remapPrivateInputError(error);}
}
async function controls(input:unknown):Promise<{data:unknown}>{
  assertWindows();
  const parsed=z.object({hwnd:WindowHandleSchema}).strict().parse(input);
  const s=await readState();
  if(!s||!alive(s.hostPid)||!alive(s.shellPid))
    throw new PrivateDesktopError('NOT_RUNNING','Private desktop is not running.');
  const result=ControlScanSchema.parse(await privateInputRequest('controls',{
    desktop:DESKTOP_NAME,hwnd:parsed.hwnd,
  }));
  return{data:{...result,desktopName:DESKTOP_NAME,
    boundsRelativeTo:'TOP_LEVEL_CLIENT',textContentReturned:false,
    visibleDesktopChanged:false}};
}
async function windows():Promise<{data:unknown}>{assertWindows();const s=await readState();if(!s||!alive(s.hostPid))throw new PrivateDesktopError('NOT_RUNNING','Private desktop is not running.');const v=await view();return{data:{desktopName:DESKTOP_NAME,inputDesktop:v.inputDesktop,windows:v.windows,visibleDesktopChanged:false}};}


const NAMED_VIRTUAL_KEYS: Readonly<Record<string, number>> = Object.freeze({
  CTRL: 0x11,
  CONTROL: 0x11,
  ALT: 0x12,
  SHIFT: 0x10,
  WIN: 0x5B,
  META: 0x5B,
  LWIN: 0x5B,
  RWIN: 0x5C,
  ENTER: 0x0D,
  TAB: 0x09,
  ESC: 0x1B,
  ESCAPE: 0x1B,
  BACKSPACE: 0x08,
  DELETE: 0x2E,
  SPACE: 0x20,
  LEFT: 0x25,
  UP: 0x26,
  RIGHT: 0x27,
  DOWN: 0x28,
  HOME: 0x24,
  END: 0x23,
  PAGEUP: 0x21,
  PAGEDOWN: 0x22,
  INSERT: 0x2D,
});

function virtualKey(nameInput: string): number {
  const name = nameInput.trim().toUpperCase();
  const named = NAMED_VIRTUAL_KEYS[name];
  if (named !== undefined) return named;

  if (/^[A-Z]$/.test(name)) {
    return name.charCodeAt(0);
  }
  if (/^[0-9]$/.test(name)) {
    return name.charCodeAt(0);
  }
  const f = /^F([1-9]|1[0-9]|2[0-4])$/.exec(name);
  if (f) {
    return 0x6F + Number(f[1]);
  }

  throw new PrivateDesktopError(
    'HOTKEY_KEY_UNSUPPORTED',
    'Unsupported private-desktop hotkey key: ' + nameInput,
    { key: nameInput },
  );
}

async function requireRunningPrivateDesktop(): Promise<PrivateDesktopState> {
  const state = await readState();
  if (
    !state ||
    !alive(state.hostPid) ||
    !alive(state.shellPid)
  ) {
    throw new PrivateDesktopError(
      'NOT_RUNNING',
      'Start the private desktop first.',
    );
  }
  return state;
}

function remapPrivateInputError(error: unknown): never {
  if (
    error instanceof PrivateDesktopError &&
    error.code === 'HELPER_FAILED'
  ) {
    for (const code of [
      'WINDOW_NOT_PRIVATE_DESKTOP',
      'WINDOW_NOT_FOUND',
      'POINT_OUTSIDE_CLIENT',
      'BUTTON_UNSUPPORTED',
      'PRIVATE_UIA_ACTION_NOT_UNIQUE',
      'PRIVATE_UIA_ACTION_TARGET_UNAVAILABLE',
      'PRIVATE_UIA_ACTION_INVENTORY_INCOMPLETE',
      'PRIVATE_UIA_INVOKE_PATTERN_UNAVAILABLE',
      'PRIVATE_UIA_VALUE_PATTERN_UNAVAILABLE',
      'HOTKEY_EMPTY',
    ]) {
      if (error.message.includes(code)) {
        throw new PrivateDesktopError(
          code,
          'Private-desktop input was rejected: ' + code + '.',
        );
      }
    }
  }
  throw error;
}

/** Graceful close: only one live top-level HWND from a process launched and
 * tracked by this private desktop may receive WM_CLOSE. Never terminate by
 * stale PID and never send messages to Default or the private shell.
 */
async function privateWindowClose(input:unknown):Promise<{data:unknown}>{
  assertWindows();
  const state=await requireRunningPrivateDesktop();
  const parsed=PrivateWindowCloseSchema.parse(input);
  const before=await view();
  const entry=before.windows.find(w=>
    w.hwnd.toUpperCase()===parsed.hwnd.toUpperCase());
  if(!entry){
    throw new PrivateDesktopError('WINDOW_NOT_PRIVATE_DESKTOP',
      'Requested HWND does not belong to NexowirePrivate.');
  }
  if(!state.launchedPids.includes(entry.processId)){
    throw new PrivateDesktopError('PRIVATE_WINDOW_UNTRACKED',
      'Only Nexowire-managed private app windows can be closed.');
  }
  // The helper checks desktop membership AGAIN immediately before WM_CLOSE,
  // preventing a reused handle from ever reaching Default windows.
  let requested:{hwnd:string;inputDesktop:string;closeRequested:boolean};
  try{
    requested=z.object({
      hwnd:z.string(),inputDesktop:z.string(),closeRequested:z.literal(true),
    }).parse(await privateInputRequest('close_window',{
      desktop:DESKTOP_NAME,hwnd:parsed.hwnd,
    }));
  }catch(error){return remapPrivateInputError(error);}
  let closed=false;
  const deadline=Date.now()+1800;
  while(Date.now()<deadline){
    const current=await view();
    if(!current.windows.some(w=>
      w.hwnd.toUpperCase()===parsed.hwnd.toUpperCase())){
      closed=true;break;
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const after=await inputDesktop();
  if(before.inputDesktop!==after ||
      requested.inputDesktop!==before.inputDesktop){
    throw new PrivateDesktopError('PRIVATE_WINDOW_CLOSE_INPUT_DESKTOP_CHANGED',
      'Physical input desktop changed during private-window close.');
  }
  return {data:{
    hwnd:requested.hwnd,processId:entry.processId,
    desktopName:DESKTOP_NAME,closeRequested:true,closed,
    inputDesktopBefore:before.inputDesktop,inputDesktopAfter:after,
    visibleDesktopChanged:false,touchesSystemCursor:false,
    forcedProcessTermination:false,
  }};
}

async function privatePointerMove(
  input: unknown,
): Promise<{ data: unknown }> {
  assertWindows();
  await requireRunningPrivateDesktop();
  const parsed = PrivatePointerMoveSchema.parse(input);
  try {
    const result = z
      .object({
        hwnd: z.string(),
        x: z.number().int(),
        y: z.number().int(),
        inputDesktop: z.string().max(256),
      })
      .parse(
        await privateInputRequest('pointer_move', {
          desktop: DESKTOP_NAME,
          hwnd: parsed.hwnd,
          x: parsed.x,
          y: parsed.y,
        }),
      );
    return {
      data: {
        ...result,
        desktopName: DESKTOP_NAME,
        touchesSystemCursor: false,
        visibleDesktopChanged: false,
      },
    };
  } catch (error) {
    return remapPrivateInputError(error);
  }
}

async function privatePointerScroll(input:unknown):Promise<{data:unknown}>{
  assertWindows();
  await requireRunningPrivateDesktop();
  const parsed=PrivatePointerScrollSchema.parse(input);
  try {
    const result=z.object({
      hwnd:z.string(),x:z.number().int(),y:z.number().int(),
      delta:z.number().int(),axis:z.enum(['vertical','horizontal']),
      inputDesktop:z.string().max(256),
    }).parse(await privateInputRequest('pointer_scroll',{
      desktop:DESKTOP_NAME,hwnd:parsed.hwnd,x:parsed.x,y:parsed.y,
      delta:parsed.delta,axis:parsed.axis,
    }));
    return {data:{
      ...result,desktopName:DESKTOP_NAME,touchesSystemCursor:false,
      visibleDesktopChanged:false,
    }};
  }catch(error){return remapPrivateInputError(error);}
}

async function privatePointerClick(
  input: unknown,
): Promise<{ data: unknown }> {
  assertWindows();
  await requireRunningPrivateDesktop();
  const parsed = PrivatePointerClickSchema.parse(input);
  try {
    const result = z
      .object({
        hwnd: z.string(),
        x: z.number().int(),
        y: z.number().int(),
        button: z.enum(['left', 'right', 'middle']),
        clicks: z.number().int().min(1).max(3),
        inputDesktop: z.string().max(256),
      })
      .parse(
        await privateInputRequest('pointer_click', {
          desktop: DESKTOP_NAME,
          hwnd: parsed.hwnd,
          x: parsed.x,
          y: parsed.y,
          button: parsed.button,
          clicks: parsed.clicks,
          ...(parsed.control_hwnd!==undefined?{control_hwnd:parsed.control_hwnd,expected_class:parsed.expected_class}:{}),
        }),
      );
    return {
      data: {
        ...result,
        desktopName: DESKTOP_NAME,
        touchesSystemCursor: false,
        visibleDesktopChanged: false,
      },
    };
  } catch (error) {
    return remapPrivateInputError(error);
  }
}

async function privateKeyboardType(
  input: unknown,
): Promise<{ data: unknown }> {
  assertWindows();
  await requireRunningPrivateDesktop();
  const parsed = PrivateKeyboardTypeSchema.parse(input);
  try {
    const result = z
      .object({
        hwnd: z.string(),
        charsSent: z.number().int().nonnegative(),
        intervalMs: z.number().int().nonnegative(),
        inputDesktop: z.string().max(256),
      })
      .parse(
        await privateInputRequest('text', {
          desktop: DESKTOP_NAME,
          hwnd: parsed.hwnd,
          text: parsed.text,
          interval_ms: parsed.interval_ms,
          ...(parsed.x!==undefined&&parsed.y!==undefined?{x:parsed.x,y:parsed.y}:{}),
          ...(parsed.control_hwnd!==undefined?{control_hwnd:parsed.control_hwnd,expected_class:parsed.expected_class}:{}),
        }),
      );
    return {
      data: {
        ...result,
        desktopName: DESKTOP_NAME,
        touchesSystemKeyboard: false,
        visibleDesktopChanged: false,
      },
    };
  } catch (error) {
    return remapPrivateInputError(error);
  }
}

/**
 * The Windows clipboard belongs to the interactive window station, not
 * strictly to one Win32 desktop. Posted shortcuts such as Ctrl+V may cause
 * a private application to query the owner's shared Windows clipboard.
 * Reject clipboard and shell-global chords rather than silently cross the
 * private AI workspace boundary. Use private_keyboard.type for text, or
 * the Agent-memory private clipboard when installed.
 */
export function assertPrivateHotkeyNoHostClipboard(keys:readonly string[]):void{
  const selected=new Set(keys.map(key=>key.trim().toUpperCase()));
  const ctrl=selected.has('CTRL')||selected.has('CONTROL');
  const shift=selected.has('SHIFT');
  const win=['WIN','META','LWIN','RWIN'].some(key=>selected.has(key));
  const clipboardChord=(ctrl&&['C','V','X','INSERT'].some(key=>selected.has(key)))
    ||(shift&&['INSERT','DELETE'].some(key=>selected.has(key)));
  const systemChord=ctrl&&selected.has('ALT')&&
    (selected.has('DELETE')||selected.has('D'));
  if(win||clipboardChord||systemChord){
    throw new PrivateDesktopError(
      'PRIVATE_HOTKEY_HOST_SHARED_NOT_ISOLATED',
      'This hotkey could reach the host clipboard or shell. Use private_keyboard.type or a verified private-memory clipboard instead.',
    );
  }
}

async function privateKeyboardHotkey(
  input: unknown,
): Promise<{ data: unknown }> {
  assertWindows();
  const parsed = PrivateKeyboardHotkeySchema.parse(input);
  assertPrivateHotkeyNoHostClipboard(parsed.keys);
  await requireRunningPrivateDesktop();
  const virtualKeys = parsed.keys.map(virtualKey);
  try {
    const result = z
      .object({
        hwnd: z.string(),
        keyCount: z.number().int().positive(),
        inputDesktop: z.string().max(256),
      })
      .parse(
        await privateInputRequest('hotkey', {
          desktop: DESKTOP_NAME,
          hwnd: parsed.hwnd,
          virtualKeys,
        }),
      );
    return {
      data: {
        ...result,
        keys: parsed.keys,
        desktopName: DESKTOP_NAME,
        touchesSystemKeyboard: false,
        visibleDesktopChanged: false,
      },
    };
  } catch (error) {
    return remapPrivateInputError(error);
  }
}

async function showPrivateDesktop(): Promise<{ data: unknown }> {
  assertWindows();
  await requireRunningPrivateDesktop();
  await ensureScripts();

  const before = await inputDesktop().catch(() => '');
  if (before === DESKTOP_NAME) {
    return {
      data: {
        shown: true,
        reused: true,
        desktopName: DESKTOP_NAME,
        inputDesktopBefore: before,
        inputDesktopAfter: before,
        visibleDesktopChanged: false,
        manualReturnHotkey: 'Ctrl+Alt+D',
      },
    };
  }

  const result = z
    .object({
      ok: z.literal(true),
      desktop: z.literal(DESKTOP_NAME),
    })
    .parse(
      await psJson([
        '-File',
        paths().switcher,
      ]),
    );

  const deadline = Date.now() + 3_000;
  let after = '';
  while (Date.now() < deadline) {
    after = await inputDesktop().catch(() => '');
    if (after === DESKTOP_NAME) break;
    await new Promise((resolve) =>
      setTimeout(resolve, 50),
    );
  }

  if (after !== DESKTOP_NAME) {
    throw new PrivateDesktopError(
      'PRIVATE_DESKTOP_SWITCH_NOT_VERIFIED',
      'Windows did not confirm NexowirePrivate as the active input desktop.',
      {
        inputDesktopBefore: before,
        inputDesktopAfter: after,
      },
    );
  }

  return {
    data: {
      ...result,
      shown: true,
      reused: false,
      desktopName: DESKTOP_NAME,
      inputDesktopBefore: before,
      inputDesktopAfter: after,
      visibleDesktopChanged: before !== after,
      manualReturnHotkey: 'Ctrl+Alt+D',
    },
  };
}

// These operations use a shared state.json/.tmp and persistent desktop
// host. Without serialization, parallel shell workers may race during host
// startup or overwrite each other's launchedPids, allowing orphan windows.
let desktopLifecycleQueue:Promise<void>=Promise.resolve();

export function serializePrivateDesktopLifecycle<T>(
  action:()=>Promise<T>,
):Promise<T>{
  const result=desktopLifecycleQueue.then(action);
  desktopLifecycleQueue=result.then(()=>undefined,()=>undefined);
  return result;
}

export async function executeWindowsPrivateDesktopCapability(
  capability: string,
  input: unknown,
): Promise<unknown> {
  switch (capability) {
    case 'windows.private_desktop.status':
      return await status();
    case 'windows.private_desktop.start':
      return await serializePrivateDesktopLifecycle(()=>
        withPrivateDesktopProcessLock(paths().root,()=>start(input)));
    case 'windows.private_desktop.stop':
      return await serializePrivateDesktopLifecycle(()=>
        withPrivateDesktopProcessLock(paths().root,()=>stop()));
    case 'windows.private_desktop.launch':
      return await serializePrivateDesktopLifecycle(()=>
        withPrivateDesktopProcessLock(paths().root,()=>launchApp(input)));
    case 'windows.private_desktop.windows':
      return await windows();
    case 'windows.private_desktop.controls':
      return await controls(input);
    case 'windows.private_desktop.accessibility':
      return await accessibility(input);
    case 'windows.private_desktop.accessibility.invoke_button':
      return await invokePrivateUiaButton(input);
    case 'windows.private_desktop.accessibility.set_edit_value':
      return await setPrivateUiaEditValue(input);
    case 'windows.private_desktop.accessibility.set_checkbox':
      return await setPrivateUiaCheckbox(input);
    case 'windows.private_desktop.accessibility.select_radio':
      return await selectPrivateUiaRadio(input);
    case 'windows.private_desktop.window.close':
      return await serializePrivateDesktopLifecycle(()=>privateWindowClose(input));
    case 'windows.private_desktop.show':
      return await showPrivateDesktop();
    case 'windows.private_pointer.move':
      return await privatePointerMove(input);
    case 'windows.private_pointer.click':
      return await privatePointerClick(input);
    case 'windows.private_pointer.scroll':
      return await privatePointerScroll(input);
    case 'windows.private_keyboard.type':
      return await privateKeyboardType(input);
    case 'windows.private_keyboard.hotkey':
      return await privateKeyboardHotkey(input);
    default:
      throw new PrivateDesktopError(
        'UNSUPPORTED',
        'Unsupported private desktop capability: ' + capability,
      );
  }
}
