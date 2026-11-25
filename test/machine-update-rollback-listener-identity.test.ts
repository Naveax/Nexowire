import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {renderMachineCutoverScript} from '../src/update/machine-update.js';

// Test child only: preserve Windows profile/TEMP, not a production launcher.
// Filter case-insensitive duplicates before overriding known inbox paths.
function fixtureEnvironment():NodeJS.ProcessEnv{
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(PATH|PSMODULEPATH|SYSTEMROOT|WINDIR)$/i.test(k)));
  return {...env,SystemRoot:'C:\\Windows',windir:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows',
    PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'};
}

const now='C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef';
const old='C:\\ProgramData\\Nexowire\\versions\\1.0.4-012345abcdef';
const script=renderMachineCutoverScript({version:'1.0.5',buildId:'1.0.5-012345abcdef',targetRoot:now});
const wait=script.split(/\r?\n/).find(x=>x.startsWith('function Wait-Service('));
assert.ok(wait,'missing generated socket-owner process proof');

test('listener identity remains scoped, but cannot authorize legacy rollback',()=>{
 assert.match(wait,/\[string\]\$runtimeRoot=\$NewRoot/);
 assert.match(wait,/\$expectedExe=\[IO\.Path\]::Combine\(\$runtimeRoot,"runtime","node\.exe"\)/);
 assert.match(wait,/\$expectedCli=\[IO\.Path\]::Combine\(\$runtimeRoot,"app","dist","src","cli\.js"\)/);
 const fallback=script.slice(script.lastIndexOf('\r\n} catch {\r\n'));
 assert.match(fallback,/MACHINE_UPDATE_SIGNED_SQLITE_ROLLBACK_AUTHORITY_REQUIRED/);
 assert.doesNotMatch(fallback,/Wait-Service|Start-ScheduledTask/);
});

const samples=[
 {name:'old runtime actually owns Hub listener',exe:old+'\\runtime\\node.exe',cli:old+'\\app\\dist\\src\\cli.js',mode:'http',expected:true},
 {name:'new runtime still owns listener',exe:now+'\\runtime\\node.exe',cli:now+'\\app\\dist\\src\\cli.js',mode:'http',expected:false},
 {name:'old binary with wrong CLI',exe:old+'\\runtime\\node.exe',cli:now+'\\app\\dist\\src\\cli.js',mode:'http',expected:false},
 {name:'old binary in wrong mode',exe:old+'\\runtime\\node.exe',cli:old+'\\app\\dist\\src\\cli.js',mode:'privileged-broker run',expected:false},
 {name:'foreign binary forges old CLI',exe:'C:\\Users\\Public\\node.exe',cli:old+'\\app\\dist\\src\\cli.js',mode:'http',expected:false},
];
for(const sample of samples){
 test(sample.name,{skip:process.platform!=='win32'},()=>{
  const command='"'+sample.exe+'" "'+sample.cli+'" '+sample.mode;
  const q=(s:string)=>"'"+s.replaceAll("'","''")+"'";
  const ps=[
   "$ErrorActionPreference='Stop'",
      '[Console]::Error.WriteLine("AI05_PS_STARTED")',
      "Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1' -ErrorAction Stop",
      '[Console]::Error.WriteLine("AI05_PS_UTILITY_LOADED")',
   '$NewRoot='+q(now),
   '$OldRoot='+q(old),
   'function Get-NetTCPConnection {param([int]$LocalPort,[string]$State,[string]$ErrorAction) return [pscustomobject]@{OwningProcess=4567}}',
   'function Get-CimInstance {param([string]$ClassName,[string]$Filter,[string]$ErrorAction) return [pscustomobject]@{Name="node.exe";ExecutablePath='+q(sample.exe)+';CommandLine='+q(command)+'}}',
   'function Start-Sleep {param([int]$Milliseconds)}',
   wait,
   '[Console]::Error.WriteLine("AI05_PS_LISTENER_FIXTURE_ENTERED")',
   "$result=Wait-Service 43110 'cli\\.js\"?\\s+http(?:\\s|$)' 1 $OldRoot",
   '[Console]::WriteLine([string]$result)',
  ].join('\r\n');
  const started=performance.now();
  const p=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
   ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{
    cwd:'C:\\Windows\\System32',env:fixtureEnvironment(),encoding:'utf8',timeout:10_000,maxBuffer:128*1024,windowsHide:true,
  });
  const diagnostic=JSON.stringify({error:(p.error as NodeJS.ErrnoException|undefined)?.code??null,signal:p.signal,status:p.status,elapsedMs:Math.round(performance.now()-started),stdout:p.stdout,stderr:p.stderr});
  assert.equal(p.error,undefined,diagnostic);
  assert.equal(p.signal,null,diagnostic);
  assert.equal(p.status,0,diagnostic);
  assert.match(p.stderr,/AI05_PS_LISTENER_FIXTURE_ENTERED/);
  assert.equal(p.stdout.trim(),sample.expected?'True':'False');
 });
}
