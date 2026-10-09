import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
  renderMachineCutoverScript,
} from '../src/update/machine-update.js';

const update={
  version:'1.0.5',buildId:'1.0.5-012345abcdef',
  targetRoot:'C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef',
};
const rendered=()=>renderMachineCutoverScript(update);
const serviceFunction=()=>{
  const line=rendered().split(/\r?\n/).find(x=>x.startsWith('function Wait-Service('));
  assert.ok(line,'expected PID-correlated listener check');
  return line;
};

test('machine update health requires listener and requested runtime to share a PID',()=>{
  const script=rendered();
  assert.match(script,/function Wait-Service\(/);
  assert.match(script,/Get-NetTCPConnection -LocalPort \$port -State Listen/);
  assert.match(script,/Get-CimInstance Win32_Process -Filter \("ProcessId="\+\[int\]\$socket.OwningProcess\)/);
  assert.match(script,/\$p\.Name -ieq "node\.exe"/);
  assert.match(script,/\$p\.CommandLine -match \[regex\]::Escape\(\$NewRoot\)/);
  assert.ok(script.includes("Wait-Service 43110 'cli\\.js\"?\\s+http(?:\\s|$)' 30"));
  assert.ok(script.includes("Wait-Service 43112 'privileged-broker\\s+run(?:\\s|$)' 20"));
  assert.doesNotMatch(script,/Wait-Port\(/);
  assert.doesNotMatch(script,/Wait-Mode\(/);
  assert.match(script,/Write-Status 'rolled_back'/);
});

type Scenario={
  socketOwner:number;
  process:Record<number,{name:string;commandLine:string}>;
  port:number;
  mode:string;
  expected:boolean;
};

const root=update.targetRoot;
const cliCmd='"'+root+'\\runtime\\node.exe" "'+root+'\\app\\dist\\src\\cli.js" http';
const brokerCmd='"'+root+'\\runtime\\node.exe" "'+root+'\\app\\dist\\src\\cli.js" privileged-broker run';
const previousCmd='"C:\\Old\\Nexowire\\runtime\\node.exe" "C:\\Old\\Nexowire\\app\\dist\\src\\cli.js" http';

const scenarios:Record<string,Scenario>={
  'same PID owns Hub port and executes requested new runtime':{
    socketOwner:202,process:{202:{name:'node.exe',commandLine:cliCmd}},
    port:43110,mode:'cli\\.js"?\\s+http(?:\\s|$)',expected:true,
  },
  'old process holds Hub port while unrelated new process is running':{
    socketOwner:101,
    process:{101:{name:'node.exe',commandLine:previousCmd},
             202:{name:'node.exe',commandLine:cliCmd}},
    port:43110,mode:'cli\\.js"?\\s+http(?:\\s|$)',expected:false,
  },
  'new node.exe runs wrong mode on Hub listener':{
    socketOwner:202,process:{202:{name:'node.exe',commandLine:brokerCmd}},
    port:43110,mode:'cli\\.js"?\\s+http(?:\\s|$)',expected:false,
  },
  'new command line belongs to wrong executable':{
    socketOwner:202,process:{202:{name:'powershell.exe',commandLine:cliCmd}},
    port:43110,mode:'cli\\.js"?\\s+http(?:\\s|$)',expected:false,
  },
  'new process owns Broker listener with correct mode':{
    socketOwner:203,process:{203:{name:'node.exe',commandLine:brokerCmd}},
    port:43112,mode:'privileged-broker\\s+run(?:\\s|$)',expected:true,
  },
  'Hub process owns Broker port instead of Broker':{
    socketOwner:202,process:{202:{name:'node.exe',commandLine:cliCmd}},
    port:43112,mode:'privileged-broker\\s+run(?:\\s|$)',expected:false,
  },
};

for(const [name,scenario] of Object.entries(scenarios)){
  test(name,{skip:process.platform!=='win32'},()=>{
    const switchCases=Object.entries(scenario.process).map(([pid,p])=>
      '    '+pid+" { return [pscustomobject]@{Name='"+p.name+"';CommandLine='"+p.commandLine.replaceAll("'","''")+"'}}"
    );
    const psScript=[
      "$ErrorActionPreference='Stop'",
      "$NewRoot='C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef'",
      'function Get-NetTCPConnection {',
      '  param([int]$LocalPort,[string]$State,[string]$ErrorAction)',
      '  if($LocalPort -eq '+scenario.port+'){',
      '    return [pscustomobject]@{OwningProcess='+scenario.socketOwner+'}',
      '  }',
      '}',
      'function Get-CimInstance {',
      '  param([string]$ClassName,[string]$Filter,[string]$ErrorAction)',
      "  $pidNumber=[int]($Filter -replace '^ProcessId=','')",
      '  switch($pidNumber){',
      ...switchCases,
      '    default {return $null}',
      '  }',
      '}',
      'function Start-Sleep { param([int]$Milliseconds) }',
      serviceFunction(),
      "$result=Wait-Service "+scenario.port+" '"+scenario.mode+"' 1",
      '[Console]::WriteLine([string]$result)',
    ].join('\n');
    const command=Buffer.from(psScript,'utf16le').toString('base64');
    const output=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',command],{
        cwd:'C:\\Windows\\System32',
        env:{
          SystemRoot:'C:\\Windows',windir:'C:\\Windows',
          PATH:'C:\\Windows\\System32;C:\\Windows',
          PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
        },
        encoding:'utf8',timeout:10_000,maxBuffer:128*1024,
        windowsHide:true,
      });
    assert.equal(output.status,0,output.stderr);
    assert.equal(output.stdout.trim(),scenario.expected?'True':'False');
  });
}
