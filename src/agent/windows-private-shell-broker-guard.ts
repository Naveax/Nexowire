import path from 'node:path';

/**
 * Catch high-confidence shell/COM broker invocations *before* starting the
 * private shell worker. This is intentionally narrow and is NOT a parser,
 * application sandbox or transitive descendant isolation mechanism.
 *
 * Only explicit shell command strings are inspected here. Opaque compiled
 * programs, dynamically assembled commands and external script files still
 * need the separate guest/session acceptance boundary in #402.
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
