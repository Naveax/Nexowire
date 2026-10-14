import path from 'node:path';
import {promises as fs} from 'node:fs';

/**
 * Catch high-confidence shell/COM broker invocations *before* starting the
 * private shell worker. This is intentionally narrow and is NOT a parser,
 * application sandbox or transitive descendant isolation mechanism.
 *
 * Only explicit shell command strings are inspected here. A separate
 * bounded -File script preflight catches obvious static brokers in external
 * scripts, but dynamic code/compiled programs still require #402's separate
 * session/guest acceptance boundary.
 */
export function assertNoObviousPrivateShellBrokerInvocation(
  executable:string,args:readonly string[],
):void {
  const name=path.win32.basename(executable.trim()).toLowerCase();
  // The worker's child spawn is NOT routed through private_desktop.launch
  // and would otherwise bypass the direct-executable broker denylist.
  const directBrokers=new Set([
    'explorer.exe','control.exe','rundll32.exe','dllhost.exe',
    'mshta.exe','wscript.exe','cscript.exe','msiexec.exe',
    'fodhelper.exe','computerdefaults.exe','eventvwr.exe',
    'sdclt.exe','slui.exe','hh.exe',
  ]);
  if(directBrokers.has(name)){
    throw Object.assign(new Error(
      'Private shell worker cannot launch a Windows GUI/COM broker directly.',
    ),{code:'AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED'});
  }
  const isPowerShell=['pwsh','pwsh.exe','powershell','powershell.exe'].includes(name);
  const isCmd=['cmd','cmd.exe'].includes(name);
  if(!isPowerShell&&!isCmd)return;
  const normalizedArgs=args.map(x=>x.trim().toLowerCase());
  if(isPowerShell && normalizedArgs.some(x=>
      ['-encodedcommand','-enc','-e'].includes(x))) {
    throw Object.assign(new Error(
      'Opaque encoded PowerShell is not audited for private GUI isolation.',
    ),{code:'AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED'});
  }
  const commandIndex=normalizedArgs.findIndex(x=>isPowerShell
    ?['-command','-c'].includes(x)
    :['/c','/k'].includes(x));
  if(commandIndex<0||commandIndex+1>=args.length)return;
  const command=args.slice(commandIndex+1).join(' ');
  const explicitBroker=/(?:^|[;&|\r\n])\s*(?:(?:&|call)\s+)?(?:start-process|saps|invoke-item|ii|invoke-expression|iex|start)(?=\s|$|[('"\x22])/i;
  const hostExecutable=/(?:^|[;&|\r\n])\s*(?:&\s*)?(?:(?:[A-Za-z]:[\\/][^\s"';&|]+[\\/])?)(?:explorer|control|rundll32|mshta|msiexec|wscript|cscript|dllhost|fodhelper|computerdefaults|eventvwr|slui|sdclt)\.exe(?=\s|$|["'])/i;
  const runAs=/(?:^|\s)-Verb\s+(?:RunAs|RunAsUser)(?=\s|$|['"])/i;
  const shellObject=/\b(?:ShellExecute(?:Ex)?|Shell\.Application|WScript\.Shell)\b/i;
  const dotNetProcessStart=/\b(?:System\.Diagnostics\.Process|\[Diagnostics\.Process\])(?:::|\]::)Start\s*\(/i;
  if([explicitBroker,hostExecutable,runAs,shellObject,dotNetProcessStart]
    .some(pattern=>pattern.test(command))){
    throw Object.assign(new Error(
      'Shell command contains a known Windows GUI/elevation broker. '+
      'It may open on the owner Default/Secure Desktop; use an explicitly '+
      'verified direct private-window launch instead.',
    ),{code:'AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED'});
  }
}


/**
 * Preflight the literal content of a PowerShell -File script before any
 * private worker/desktop process is created. This detects obvious static
 * shell/elevation brokerage that the command-argument guard cannot see.
 *
 * This is not a PowerShell interpreter, cannot follow imports/aliases/
 * dynamic expressions, and does not eliminate script TOCTOU or downstream
 * COM/executable brokerage. Fail closed on an unreadable/oversized script.
 */
export async function assertNoObviousPrivateShellScriptBrokerInvocation(
  executable:string,args:readonly string[],cwd?:string,
):Promise<void>{
  assertNoObviousPrivateShellBrokerInvocation(executable,args);
  const name=path.win32.basename(executable.trim().replace(/^["']|["']$/g,''))
    .toLowerCase();
  if(!['pwsh','pwsh.exe','powershell','powershell.exe'].includes(name))return;
  const index=args.findIndex(a=>['-file','-f'].includes(a.trim().toLowerCase()));
  if(index<0)return;
  const fileArg=args[index+1];
  const fail=(message:string):never=>{
    throw Object.assign(new Error(message),{
      code:'AI_PRIVATE_SHELL_SCRIPT_BROKER_NOT_AUDITED',
    });
  };
  if(!fileArg||fileArg==='-'||fileArg.startsWith('-')||
     fileArg.includes('\0')||!fileArg.toLowerCase().endsWith('.ps1')){
    return fail('PowerShell -File requires a locally readable .ps1 for private GUI preflight.');
  }
  const source=path.resolve(cwd??process.cwd(),fileArg);
  let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
  try{
    const entry=await fs.lstat(source);
    if(!entry.isFile()||entry.isSymbolicLink()||entry.size>262_144){
      fail('Private PowerShell file is not a regular bounded script.');
    }
    handle=await fs.open(source,'r');
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>262_144){
      fail('Private PowerShell file size/type changed during preflight.');
    }
    const contents=await handle.readFile();
    const script=contents.length>=2&&contents[0]===0xff&&contents[1]===0xfe
      ? contents.subarray(2).toString('utf16le')
      :contents.toString('utf8').replace(/^\uFEFF/,'');
    assertNoObviousPrivateShellBrokerInvocation(
      'powershell.exe',['-Command',script],
    );
  }catch(error){
    if(error instanceof Error&&'code'in error&&
      (error.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED'||
       error.code==='AI_PRIVATE_SHELL_SCRIPT_BROKER_NOT_AUDITED'))throw error;
    fail('PowerShell -File cannot be read for private GUI broker preflight.');
  }finally{
    await handle?.close();
  }
}
