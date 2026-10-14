import {spawnSync} from 'node:child_process';

export const PRIVATE_WORKER_DESKTOP_NAME='WinSta0\\NexowirePrivate';

export class PrivateWorkerDesktopIdentityError extends Error {
  readonly code='PRIVATE_PROCESS_WORKER_DESKTOP_UNVERIFIED';
  constructor(message:string){
    super(message);
    this.name='PrivateWorkerDesktopIdentityError';
  }
}

// Fixed first-party probe only. The PowerShell child inherits the worker's
// window station/desktop; GetProcessWindowStation and GetThreadDesktop observe the
// child station and thread attachment without inspecting the owner's windows or input.
const probe=[
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  "$definition=@'",
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public static class NxWorkerDesktopIdentity {',
  ' [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  ' [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint tid);',
  ' [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();',
  ' [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]',
  ' public static extern bool GetUserObjectInformation(IntPtr h,int index,StringBuilder b,int len,out int needed);',
  ' private static string Name(IntPtr h) {',
  '  if(h==IntPtr.Zero)throw new Exception("NO_USER_OBJECT_HANDLE");',
  '  int n;GetUserObjectInformation(h,2,null,0,out n);',
  '  if(n<=0)throw new Exception("NO_USER_OBJECT_NAME_LENGTH");',
  '  var b=new StringBuilder(n/2+4);',
  '  if(!GetUserObjectInformation(h,2,b,b.Capacity*2,out n))',
  '    throw new Exception("USER_OBJECT_NAME_QUERY_FAILED");',
  '  return b.ToString();',
  ' }',
  ' public static string Current() {',
  '  return Name(GetProcessWindowStation())+"\\\\"+Name(GetThreadDesktop(GetCurrentThreadId()));',
  ' }',
  '}',
  "'@",
  'Add-Type -TypeDefinition $definition -ErrorAction Stop',
  '[Console]::Out.Write([NxWorkerDesktopIdentity]::Current())',
].join('\n');

export function assertPrivateWorkerDesktopProbeResult(
  input:{status:number|null;stdout:string;error?:Error|undefined},
):void{
  if(input.error||input.status!==0||
     input.stdout.trim()!==PRIVATE_WORKER_DESKTOP_NAME){
    throw new PrivateWorkerDesktopIdentityError(
      'Private durable worker child window station and desktop identity was not verified; '+
      'refusing requested process spawn.',
    );
  }
}

export function assertWindowsPrivateWorkerDesktopIdentity():void {
  if(process.platform!=='win32'){
    throw new PrivateWorkerDesktopIdentityError(
      'Windows private desktop identity cannot be verified on this platform.',
    );
  }
  const result=spawnSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(probe,'utf16le').toString('base64')],
    {
      shell:false,
      windowsHide:true,
      timeout:7_000,
      maxBuffer:8_192,
      encoding:'utf8',
      env:{
        SystemRoot:'C:\\Windows',
        windir:'C:\\Windows',
        ComSpec:'C:\\Windows\\System32\\cmd.exe',
        Path:'C:\\Windows\\System32;C:\\Windows',
        PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
        ...(process.env.TEMP?{TEMP:process.env.TEMP}:{}),
        ...(process.env.TMP?{TMP:process.env.TMP}:{}),
      },
    },
  );
  assertPrivateWorkerDesktopProbeResult({
    status:result.status,
    stdout:result.stdout??'',
    error:result.error,
  });
}
