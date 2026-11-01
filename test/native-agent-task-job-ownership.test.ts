import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  buildNativeAgentLauncher,
  nativeAgentTaskStartConfirmed,
  nativeAgentTaskStopConfirmed,
  type WindowsAgentTaskOwnerReadback,
} from '../src/agent/native-agent-lifecycle.js';

const helper='C:\\Nexowire\\app\\dist\\native\\windows-job-owner.exe';
const input={
  platform: 'win32' as const,
  execPath: 'C:\\Nexowire\\runtime\\node.exe',
  execArgv: [] as string[],
  cliEntrypoint: 'C:\\Nexowire\\app\\dist\\src\\cli.js',
  windowsTaskJobOwnerPath: helper,
  env: {NEXOWIRE_DEVICE_NAME:'Isolated Job Test'},
};

const snapshot=(patch:Partial<WindowsAgentTaskOwnerReadback>={}):WindowsAgentTaskOwnerReadback=>({
  installed:true,state:'ready',guarded:true,receipts:1,liveRoots:0,
  liveGuardians:0,rootPid:null,...patch,
});

test('AI09 installed Agent task uses a parent-bound native Job guardian',()=>{
  const ps=buildNativeAgentLauncher(input);
  assert.ok(ps.startsWith('\uFEFF'), 'PowerShell 5.1 UTF-8 BOM preserved');
  assert.match(ps,/NEXOWIRE_AGENT_TASK_JOB_GUARD_V1/);
  assert.match(ps,/windows-job-owner\.exe/);
  assert.match(ps,/--status' \$jobMarker/);
  assert.match(ps,/--parent' \(\[string\]\$PID\)/);
  assert.match(ps,/--cwd' '-'/);
  assert.ok(ps.includes("'C:\\Nexowire\\runtime\\node.exe'"));
  assert.match(ps,/'agent' 'run'/);
  assert.ok(!ps.includes("& 'C:\\Nexowire\\runtime\\node.exe'"),
    'installed task must not spawn naked Node');
});

test('AI09 does not silently accept an unpinned/relative Job executable',()=>{
  assert.throws(
    ()=>buildNativeAgentLauncher({...input,windowsTaskJobOwnerPath:'windows-job-owner.exe'}),
    /NATIVE_AGENT_TASK_JOB_HELPER_PATH_UNCONFIRMED/,
  );
});

test('AI09 stop requires separate Scheduler, root and guardian absence',()=>{
  assert.equal(nativeAgentTaskStopConfirmed(snapshot()),true);
  for(const bad of [
    {guarded:false},{receipts:0},{state:'running'},
    {state:'queued'},{state:'unknown'},
    {liveRoots:1,rootPid:14184},{liveGuardians:1},
  ]){
    assert.equal(nativeAgentTaskStopConfirmed(snapshot(bad)),false,JSON.stringify(bad));
  }
});

test('AI09 start requires one verified Job guardian and live Agent root',()=>{
  const good=snapshot({state:'running',liveRoots:1,liveGuardians:1,rootPid:23964});
  assert.equal(nativeAgentTaskStartConfirmed(good),true);
  for(const bad of [
    {guarded:false},{state:'ready'},{liveRoots:0},{liveRoots:2},
    {liveGuardians:0},{liveGuardians:2},{rootPid:null},{rootPid:0},
  ]){
    assert.equal(nativeAgentTaskStartConfirmed({...good,...bad}),false,JSON.stringify(bad));
  }
});

test('AI09 Windows reader keeps PID birth, bounded readback, and denies unknown results',()=>{
  const source=readFileSync(new URL('../src/agent/native-agent-lifecycle.ts',import.meta.url),'utf8');
  assert.match(source,/CreationDate\.ToUniversalTime\(\)\.ToFileTimeUtc\(\)/);
  assert.match(source,/NATIVE_AGENT_TASK_RECEIPT_INVALID/);
  assert.match(source,/NATIVE_AGENT_TASK_GUARDIAN_IDENTITY_UNKNOWN/);
  assert.match(source,/NATIVE_AGENT_TASK_DESCENDANT_STOP_UNCONFIRMED/);
  assert.match(source,/NATIVE_AGENT_TASK_PREEXISTING_OWNER_UNCONFIRMED/);
  assert.match(source,/Get-CimInstance Win32_Process/);
  assert.match(source,/ErrorAction Stop/);
  assert.doesNotMatch(source,/taskkill\.exe/);
});
