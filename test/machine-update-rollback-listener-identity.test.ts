import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {renderMachineCutoverScript} from '../src/update/machine-update.js';

const now='C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef';
const old='C:\\ProgramData\\Nexowire\\versions\\1.0.4-012345abcdef';
const script=renderMachineCutoverScript({version:'1.0.5',buildId:'1.0.5-012345abcdef',targetRoot:now});
const wait=script.split(/\r?\n/).find(x=>x.startsWith('function Wait-Service('));
assert.ok(wait,'missing generated socket-owner process proof');

test('restore health checks previous runtime instead of new update root',()=>{
 assert.match(wait,/\[string\]\$runtimeRoot=\$NewRoot/);
 assert.match(wait,/\$expectedExe=\[IO\.Path\]::Combine\(\$runtimeRoot,"runtime","node\.exe"\)/);
 assert.match(wait,/\$expectedCli=\[IO\.Path\]::Combine\(\$runtimeRoot,"app","dist","src","cli\.js"\)/);
 assert.match(script,/Wait-Service 43110 .* \(\[string\]\$previousRoots\[\$BootLauncher\]\)/);
 assert.match(script,/Wait-Service 43112 .* \(\[string\]\$previousRoots\[\$BrokerLauncher\]\)/);
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
   '$NewRoot='+q(now),
   '$OldRoot='+q(old),
   'function Get-NetTCPConnection {param([int]$LocalPort,[string]$State,[string]$ErrorAction) return [pscustomobject]@{OwningProcess=4567}}',
   'function Get-CimInstance {param([string]$ClassName,[string]$Filter,[string]$ErrorAction) return [pscustomobject]@{Name="node.exe";ExecutablePath='+q(sample.exe)+';CommandLine='+q(command)+'}}',
   'function Start-Sleep {param([int]$Milliseconds)}',
   wait,
   "$result=Wait-Service 43110 'cli\\.js\"?\\s+http(?:\\s|$)' 1 $OldRoot",
   '[Console]::WriteLine([string]$result)',
  ].join('\r\n');
  const p=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
   ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{
    cwd:'C:\\Windows\\System32',env:{
     SystemRoot:'C:\\Windows',windir:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows',
     PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'
    },encoding:'utf8',timeout:10_000,maxBuffer:128*1024,windowsHide:true,
  });
  assert.equal(p.status,0,p.stderr);
  assert.equal(p.stdout.trim(),sample.expected?'True':'False');
 });
}
