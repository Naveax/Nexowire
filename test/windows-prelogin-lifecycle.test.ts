import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  planSystemAgentPrelogin,
  renderSystemAgentPreloginLauncher,
  systemAgentPreloginEnvironment,
} from '../src/agent/windows-prelogin-lifecycle.js';
import {assertWindowsPreloginStartupConfiguration} from '../src/agent/windows-prelogin-bootstrap.js';
import {persistedNativeAgentEnvironment} from '../src/agent/native-agent-lifecycle.js';

const exe='C:\\Program Files\\nodejs\\node.exe';
const cli='C:\\Program Files\\Nexowire\\app\\dist\\src\\cli.js';

test('SYSTEM agent plan uses separate ProgramData root and bundled guardian',()=>{
  const p=planSystemAgentPrelogin(exe,cli);
  assert.equal(p.taskName,'Nexowire Prelogin Agent');
  assert.equal(p.root,'C:\\ProgramData\\Nexowire\\system-agent');
  assert.equal(p.stateRoot,p.root+'\\state');
  assert.equal(p.identityFile,p.root+'\\agent.json');
  assert.equal(p.tokenFile,p.root+'\\agent-token.machine.dpapi.json');
  assert.equal(p.jobHelper,'C:\\Program Files\\Nexowire\\app\\dist\\native\\windows-job-owner.exe');
  assert.throws(()=>planSystemAgentPrelogin('node','src/cli.js'),/ABSOLUTE/);
});

test('staged environment uses independent machine credentials and state',()=>{
  const env=systemAgentPreloginEnvironment();
  assert.equal(env.NEXOWIRE_WINDOWS_PRELOGIN_AGENT,'1');
  assert.equal(env.NEXOWIRE_HUB_WS_URL,'ws://127.0.0.1:43110/agent');
  assert.match(env.NEXOWIRE_AGENT_TOKEN_DPAPI_FILE??'',/system-agent\\agent-token\.machine\.dpapi\.json$/);
  assert.match(env.NEXOWIRE_AGENT_IDENTITY_FILE??'',/system-agent\\agent\.json$/);
  assert.equal(env.NEXOWIRE_PRIVILEGED_BROKER_TOKEN,undefined);
  assert.equal(env.NEXOWIRE_CORE_AUTHORITY_URL,undefined);
  assert.equal(assertWindowsPreloginStartupConfiguration(env,'win32').root,
    'C:\\ProgramData\\Nexowire\\system-agent');
});

test('launcher persistence retains machine paths without plaintext',()=>{
  const env=persistedNativeAgentEnvironment(systemAgentPreloginEnvironment());
  assert.equal(env.NEXOWIRE_WINDOWS_PRELOGIN_AGENT,'1');
  assert.match(env.NEXOWIRE_AGENT_IDENTITY_FILE??'',/system-agent\\agent\.json$/);
  assert.equal(env.NEXOWIRE_AGENT_TOKEN,undefined);
  const l=renderSystemAgentPreloginLauncher(planSystemAgentPrelogin(exe,cli));
  assert.equal(l.charCodeAt(0),0xFEFF);
  assert.match(l,/NEXOWIRE_WINDOWS_PRELOGIN_AGENT/);
  assert.match(l,/NEXOWIRE_AGENT_IDENTITY_FILE/);
  assert.match(l,/NEXOWIRE_AGENT_TOKEN_DPAPI_FILE/);
  assert.match(l,/NEXOWIRE_AGENT_TASK_JOB_GUARD_V1/);
  assert.match(l,/windows-job-owner\.exe/);
  assert.match(l,/\$jobMarker=Join-Path 'C:\\ProgramData\\Nexowire\\system-agent\\state'/);
  assert.doesNotMatch(l,/\$jobMarker=Join-Path \$PSScriptRoot/);
  for(const forbidden of ['NEXOWIRE_CORE_AUTHORITY_URL','NEXOWIRE_PRIVILEGED_BROKER_TOKEN',
    'NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME','NEXOWIRE_ALLOWED_ROOTS'])
    assert.doesNotMatch(l,new RegExp(forbidden));
});

test('stage validates trust and task identity before reading and copying a token',()=>{
  const code=readFileSync(new URL('../src/agent/windows-prelogin-lifecycle.ts',import.meta.url),'utf8');
  const start=code.indexOf('export async function stageSystemAgentPrelogin(');
  const stop=code.indexOf('async function assertSafeStageCleanup(',start);
  const stage=code.slice(start,stop);
  assert.ok(stage.indexOf('ensureRuntime(plan)')>=0);
  assert.ok(stage.indexOf('verifyHelper(plan)')>stage.indexOf('ensureRuntime(plan)'));
  assert.ok(stage.indexOf('if(task.installed)')>stage.indexOf('verifyHelper(plan)'));
  assert.ok(stage.indexOf('readProtectedSecretFile(')>stage.indexOf('if(task.installed)'));
  assert.ok(stage.indexOf('await fs.mkdir(plan.root')>stage.indexOf('readProtectedSecretFile('));
  assert.match(stage,/scope:'local-machine'/);
  assert.match(stage,/hardenWindowsProgramDataAcl\(plan.root\)/);
  assert.match(stage,/hardenWindowsProgramDataAcl\(plan.stateRoot\)/);
});

test('install task requires SYSTEM Hub and installs only its own AtStartup task',()=>{
  const code=readFileSync(new URL('../src/agent/windows-prelogin-lifecycle.ts',import.meta.url),'utf8');
  const s=code.slice(code.indexOf('export async function installStagedSystemAgentPrelogin('),
    code.indexOf('export async function uninstallSystemAgentPrelogin('));
  assert.match(s,/await hubBootLifecycleStatus\(\)/);
  assert.match(s,/PRELOGIN_AGENT_TRUSTED_SYSTEM_HUB_BOOT_REQUIRED/);
  assert.match(s,/PRELOGIN_AGENT_EXISTING_TASK_INSTALL_DENIED/);
  assert.match(s,/New-ScheduledTaskTrigger -AtStartup/);
  assert.match(s,/New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount/);
  assert.match(s,/WINDOWS_NATIVE_AGENT_TASK_SETTINGS/);
  assert.match(s,/Description "\+ps\(manifest\.marker\)/);
  assert.match(s,/uninstallSystemAgentPrelogin\(\)/);
  assert.doesNotMatch(s,/Register-ScheduledTask[^\n]*-Force/);
});

test('rollback is marker-bound and preserves state for reconciliation',()=>{
  const code=readFileSync(new URL('../src/agent/windows-prelogin-lifecycle.ts',import.meta.url),'utf8');
  const s=code.slice(code.indexOf('export async function uninstallSystemAgentPrelogin('),
    code.indexOf('export async function runSystemAgentPreloginLifecycleCommand('));
  assert.match(s,/if\(!task\.identityVerified\)/);
  assert.match(s,/task\.description!==manifest\.marker/);
  assert.match(s,/Unregister-ScheduledTask/);
  assert.doesNotMatch(s,/fs\.rm\(/);
  assert.doesNotMatch(s,/Disable-ScheduledTask/);
  assert.doesNotMatch(s,/Nexowire Native Agent/);
});

test('CLI routes prelogin lifecycle separately from interactive Agent',()=>{
  const cliSource=readFileSync(new URL('../src/cli.ts',import.meta.url),'utf8');
  for(const name of ['prelogin-status','prelogin-stage','prelogin-install','prelogin-uninstall'])
    assert.ok(cliSource.includes("action === '"+name+"'"));
  assert.match(cliSource,/runSystemAgentPreloginLifecycleCommand\(process\.argv\.slice\(3\)\)/);
  assert.match(cliSource,/runNativeAgentLifecycleCommand\(\s*process\.argv\.slice\(3\),?\s*\)/);
});

test('task shell is fixed Windows PowerShell with bounded noninteractive execution',()=>{
  const source=readFileSync(new URL('../src/agent/windows-prelogin-lifecycle.ts',import.meta.url),'utf8');
  const start=source.indexOf('function taskShell(script:string):unknown{');
  const end=source.indexOf('interface TaskProbe',start);
  const shell=source.slice(start,end);
  assert.ok(start>0&&end>start);
  assert.match(shell,/spawnSync\(POWERSHELL/);
  assert.match(shell,/NonInteractive/);
  assert.match(shell,/EncodedCommand/);
  assert.match(shell,/shell:false/);
  assert.match(shell,/timeout:30_000/);
  assert.match(shell,/maxBuffer:256\*1024/);
  assert.match(shell,/stdio:\['ignore','pipe','pipe'\]/);
  assert.match(shell,/PSModulePath:/);
  assert.doesNotMatch(shell,/\bexecSync\(|Start-Process|UseShellExecute/);
});

test('CI executes prelogin lifecycle tests on actual Windows Node 22 and 24',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const win=workflow.slice(workflow.indexOf('  connection-v2-negative-windows:'),
    workflow.indexOf('  connection-v2-native-git-dag:'));
  assert.match(win,/node-version: \[22, 24\]/);
  assert.match(win,/test\/windows-prelogin-lifecycle\.test\.ts/);
});
