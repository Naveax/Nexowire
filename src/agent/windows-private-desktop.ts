import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';

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
  });

const PrivateKeyboardTypeSchema = z.object({
  hwnd: WindowHandleSchema,
  text: z.string().min(1).max(20_000),
  interval_ms: z.number().int().min(0).max(100).default(0),
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
  } catch {
    return false;
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
  try {
    const value = JSON.parse(await fs.readFile(paths().state, 'utf8'));
    return z.object({
      version: z.literal(1),
      desktopName: z.literal(DESKTOP_NAME),
      hostPid: z.number().int().positive(),
      shellPid: z.number().int().positive(),
      launchedPids: z.array(z.number().int().positive()).max(1024),
      startedAt: z.string().min(1),
    }).parse(value) as PrivateDesktopState;
  } catch {
    return undefined;
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
  public const uint MK_LBUTTON=0x0001, MK_RBUTTON=0x0002, MK_MBUTTON=0x0010;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct SI {
    public int cb; public string reserved; public string desktop; public string title;
    public int x,y,xs,ys,xc,yc,fill,flags; public short show,cb2; public IntPtr r2,stdin,stdout,stderr;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
  public sealed class W { public string Hwnd; public string Title; public int ProcessId; public bool Visible; public int Left,Top,Right,Bottom; }
  delegate bool EnumProc(IntPtr hwnd, IntPtr l);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenDesktop(string n,int f,bool i,uint a);
  [DllImport("user32.dll",SetLastError=true)] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint f,bool i,uint a);
  [DllImport("user32.dll",SetLastError=true)] static extern bool EnumDesktopWindows(IntPtr h,EnumProc p,IntPtr l);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll",SetLastError=true)] static extern bool GetClientRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
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
  public static string PointerMove(string name,string raw,int x,int y){
    var h=Target(name,raw);var l=XY(h,x,y);Post(h,WM_MOUSEMOVE,UIntPtr.Zero,l);return "0x"+h.ToInt64().ToString("X");
  }
  public static string PointerClick(string name,string raw,int x,int y,string button,int clicks){
    var h=Target(name,raw);var l=XY(h,x,y);uint down,up,mask;
    switch((button??"left").ToLowerInvariant()){
      case "left":down=WM_LBUTTONDOWN;up=WM_LBUTTONUP;mask=MK_LBUTTON;break;
      case "right":down=WM_RBUTTONDOWN;up=WM_RBUTTONUP;mask=MK_RBUTTON;break;
      case "middle":down=WM_MBUTTONDOWN;up=WM_MBUTTONUP;mask=MK_MBUTTON;break;
      default:throw new InvalidOperationException("BUTTON_UNSUPPORTED");
    }
    Post(h,WM_MOUSEMOVE,UIntPtr.Zero,l);
    for(int i=0;i<clicks;i++){Post(h,down,new UIntPtr(mask),l);Post(h,up,UIntPtr.Zero,l);}
    return "0x"+h.ToInt64().ToString("X");
  }
  public static string Text(string name,string raw,string text,int intervalMs){
    var h=Target(name,raw);
    foreach(char ch in text??""){Post(h,WM_CHAR,new UIntPtr((uint)ch),IntPtr.Zero);if(intervalMs>0)System.Threading.Thread.Sleep(intervalMs);}
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
  [ValidateSet('pointer_move','pointer_click','text','hotkey')]
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
  } elseif ($Action -eq 'pointer_click') {
    $h=[NxDesktopNative]::PointerClick([string]$r.desktop,[string]$r.hwnd,[int]$r.x,[int]$r.y,[string]$r.button,[int]$r.clicks)
    [pscustomobject]@{hwnd=$h;x=[int]$r.x;y=[int]$r.y;button=[string]$r.button;clicks=[int]$r.clicks;inputDesktop=[NxDesktopNative]::Input()}
  } elseif ($Action -eq 'text') {
    $h=[NxDesktopNative]::Text([string]$r.desktop,[string]$r.hwnd,[string]$r.text,[int]$r.interval_ms)
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
  foreach($candidate in @('WINDOW_NOT_PRIVATE_DESKTOP','WINDOW_NOT_FOUND','POINT_OUTSIDE_CLIENT','BUTTON_UNSUPPORTED','HOTKEY_EMPTY')){
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
    const child = spawn('powershell.exe', ['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',...args], { windowsHide:true, stdio:['ignore','pipe','pipe'] });
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
  | 'text'
  | 'hotkey';

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
      'powershell.exe',
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

async function launch(
  executable: string,
  args: string[],
  cwd?: string,
): Promise<number> {
  const resolvedExecutable = await resolveExecutable(executable);
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
async function inputDesktop():Promise<string>{return z.object({inputDesktop:z.string().max(256)}).parse(await request('input',{desktop:DESKTOP_NAME})).inputDesktop;}

async function shortcut():Promise<string|null>{
  if(process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT==='1')return null;const p=paths();const app=process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming');const dir=path.join(app,'Microsoft','Windows','Start Menu','Programs');const link=path.join(dir,'Nexowire Private Desktop.lnk');await fs.mkdir(dir,{recursive:true});
  const f=path.join(p.root,'shortcut-'+process.pid+'.ps1');const q=(v:string)=>v.replace(/'/g,"''");const s=["$ErrorActionPreference='Stop'","$w=New-Object -ComObject WScript.Shell","$s=$w.CreateShortcut('"+q(link)+"')","$s.TargetPath='powershell.exe'","$s.Arguments='-NoLogo -NoProfile -ExecutionPolicy Bypass -File \""+q(p.switcher)+"\"'","$s.WorkingDirectory=[Environment]::GetFolderPath('UserProfile')","$s.Description='Open Nexowire Private Desktop'","$s.Hotkey='CTRL+ALT+N'",'$s.Save()'].join('\n');await fs.writeFile(f,s,'utf8');try{await psJson(['-File',f]);}finally{await fs.rm(f,{force:true});}return link;
}

async function start(input:unknown):Promise<{data:unknown}>{
  assertWindows();const parsed=StartSchema.parse(input);await ensureScripts();const p=paths();const old=await readState();if(old&&alive(old.hostPid)&&alive(old.shellPid))return{data:{running:true,reused:true,desktopName:DESKTOP_NAME,hostPid:old.hostPid,shellPid:old.shellPid,inputDesktop:await inputDesktop(),visibleDesktopChanged:false}};
  await Promise.all([fs.rm(p.state,{force:true}),fs.rm(p.ready,{force:true}),fs.rm(p.shellPid,{force:true})]);const host=spawn('powershell.exe',['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',p.host,'-Name',DESKTOP_NAME,'-Ready',p.ready,'-ShellPid',p.shellPid],{detached:false,windowsHide:true,cwd:p.root,stdio:'ignore'});if(!host.pid)throw new PrivateDesktopError('HOST_START_FAILED','No PID for private desktop host.');host.unref();
  const end=Date.now()+8000;let ready=false;while(Date.now()<end){if(!alive(host.pid))break;try{await fs.access(p.ready);ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}if(!ready){if(alive(host.pid))process.kill(host.pid);throw new PrivateDesktopError('NOT_READY','Private desktop host did not become ready.');}
  let shellPid:number|undefined;try{shellPid=await launch('powershell.exe',['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',p.shell],p.root);await fs.writeFile(p.shellPid,String(shellPid)+'\n','utf8');await new Promise(r=>setTimeout(r,800));if(!alive(shellPid))throw new PrivateDesktopError('SHELL_START_FAILED','Private desktop shell exited during startup.');const state:PrivateDesktopState={version:1,desktopName:DESKTOP_NAME,hostPid:host.pid,shellPid,launchedPids:[],startedAt:new Date().toISOString()};await writeState(state);const link=parsed.create_shortcut?await shortcut():null;const v=await view();return{data:{running:true,reused:false,desktopName:DESKTOP_NAME,hostPid:host.pid,shellPid,windowCount:v.windows.length,inputDesktop:v.inputDesktop,visibleDesktopChanged:false,shortcut:link,manualSwitchHotkey:link?'Ctrl+Alt+N':null}};}catch(e){if(shellPid&&alive(shellPid)){try{process.kill(shellPid);await waitExit(shellPid);}catch{}}if(alive(host.pid)){try{process.kill(host.pid);await waitExit(host.pid);}catch{}}await Promise.all([fs.rm(p.state,{force:true}),fs.rm(p.shellPid,{force:true}),fs.rm(p.ready,{force:true})]);throw e;}
}

async function killTree(pid:number):Promise<void>{if(!alive(pid))return;await new Promise<void>(resolve=>{const c=spawn('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});c.once('error',()=>resolve());c.once('exit',()=>resolve());});await waitExit(pid);}
async function stop():Promise<{data:unknown}>{assertWindows();const p=paths();const s=await readState();if(!s)return{data:{running:false,stopped:false,desktopName:DESKTOP_NAME}};for(const pid of [...s.launchedPids].reverse())await killTree(pid);await killTree(s.shellPid);if(alive(s.hostPid)){try{process.kill(s.hostPid);}catch{}if(!(await waitExit(s.hostPid)))throw new PrivateDesktopError('HOST_STOP_NOT_VERIFIED','Private desktop host did not exit.',{pid:s.hostPid});}await Promise.all([fs.rm(p.state,{force:true}),fs.rm(p.shellPid,{force:true}),fs.rm(p.ready,{force:true})]);return{data:{running:false,stopped:true,desktopName:DESKTOP_NAME,inputDesktop:await inputDesktop().catch(()=> '')}};}
async function launchApp(input:unknown):Promise<{data:unknown}>{assertWindows();const p=LaunchSchema.parse(input);const s=await readState();if(!s||!alive(s.hostPid)||!alive(s.shellPid))throw new PrivateDesktopError('NOT_RUNNING','Start the private desktop first.');const pid=await launch(p.executable,p.args,p.cwd);await writeState({...s,launchedPids:[...new Set([...s.launchedPids,pid])].slice(-1024)});return{data:{pid,desktopName:DESKTOP_NAME,visibleDesktopChanged:false}};}
async function status():Promise<{data:unknown}>{assertWindows();const s=await readState();if(!s||!alive(s.hostPid)||!alive(s.shellPid))return{data:{running:false,desktopName:DESKTOP_NAME,inputDesktop:await inputDesktop().catch(()=>''),visibleDesktopChanged:false}};let v:Awaited<ReturnType<typeof view>>|undefined;try{v=await view();}catch{}return{data:{running:true,desktopName:DESKTOP_NAME,hostPid:s.hostPid,shellPid:s.shellPid,launchedPids:s.launchedPids.filter(alive),startedAt:s.startedAt,inputDesktop:v?.inputDesktop??(await inputDesktop().catch(()=>'')),windowCount:v?.windows.length??null,visibleDesktopChanged:false}};}
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

async function privateKeyboardHotkey(
  input: unknown,
): Promise<{ data: unknown }> {
  assertWindows();
  await requireRunningPrivateDesktop();
  const parsed = PrivateKeyboardHotkeySchema.parse(input);
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

export async function executeWindowsPrivateDesktopCapability(
  capability: string,
  input: unknown,
): Promise<unknown> {
  switch (capability) {
    case 'windows.private_desktop.status':
      return await status();
    case 'windows.private_desktop.start':
      return await start(input);
    case 'windows.private_desktop.stop':
      return await stop();
    case 'windows.private_desktop.launch':
      return await launchApp(input);
    case 'windows.private_desktop.windows':
      return await windows();
    case 'windows.private_desktop.show':
      return await showPrivateDesktop();
    case 'windows.private_pointer.move':
      return await privatePointerMove(input);
    case 'windows.private_pointer.click':
      return await privatePointerClick(input);
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
