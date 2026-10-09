import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  isolatedNativeAgentTaskEnv,
  nativeAgentLifecycleStatus,
} from '../src/agent/native-agent-lifecycle.js';

test('native-agent Windows task controller isolates untrusted process search paths',()=>{
  const env=isolatedNativeAgentTaskEnv({
    NEXOWIRE_AGENT_TASK_NAME:'NX Native Agent',
    NEXOWIRE_AGENT_LAUNCHER:'C:\\Users\\tester\\.nexowire\\native-agent\\launch.ps1',
    PATH:'C:\\writable\\spoof',
    PSModulePath:'C:\\writable\\malicious-modules',
    NODE_OPTIONS:'--require C:\\writable\\inject.js',
    GH_HOST:'spoof.invalid',
    TEMP:'C:\\writable\\Temp',
  });
  assert.deepEqual(env,{
    SystemRoot:'C:\\Windows',
    windir:'C:\\Windows',
    ComSpec:'C:\\Windows\\System32\\cmd.exe',
    PATH:'C:\\Windows\\System32;C:\\Windows',
    PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    NEXOWIRE_AGENT_TASK_NAME:'NX Native Agent',
    NEXOWIRE_AGENT_LAUNCHER:'C:\\Users\\tester\\.nexowire\\native-agent\\launch.ps1',
  });
  assert.equal((env as NodeJS.ProcessEnv).NODE_OPTIONS,undefined);
  assert.equal((env as NodeJS.ProcessEnv).TEMP,undefined);
});
test('native-agent task controller pins trusted Windows PowerShell and module path',()=>{
  const src=readFileSync(new URL('../src/agent/native-agent-lifecycle.ts',import.meta.url),'utf8');
  assert.ok(src.includes("AGENT_TASK_POWERSHELL=AGENT_TASK_SYSTEM32+'\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"));
  assert.ok(src.includes("Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\ScheduledTasks\\ScheduledTasks.psd1'"));
  assert.ok(src.includes('isolatedNativeAgentTaskEnv(env)'));
  assert.ok(src.includes('trustedWindowsTask?env:{ ...process.env, ...env }'));
  assert.ok(src.includes('cwd:AGENT_TASK_SYSTEM32,timeout:60_000'));
  assert.ok(src.includes("New-ScheduledTaskAction -Execute 'C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"));
  assert.ok(!src.includes("    'powershell.exe',\n    ["));
});
test('read-only native-agent task status resists fake PowerShell and malicious PS modules',{
  skip:process.platform!=='win32',
},async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'nx-native-agent-task-shell-'));
  const fake=path.join(dir,'powershell.exe');
  writeFileSync(fake,'FAKE POWERSHELL NOT EXECUTED');
  try{
    const result=await nativeAgentLifecycleStatus({
      platform:'win32',
      rootDir:path.join(dir,'native-agent'),
      windowsTaskName:'NX-uninstalled-agent-status-'+process.pid,
      env:{
        PATH:dir+';'+(process.env.PATH||''),
        PSModulePath:dir,
        NODE_OPTIONS:'--require '+path.join(dir,'hook.js'),
      },
    });
    assert.equal(result.platform,'win32');
    assert.equal(result.installed,false);
    assert.equal(result.state,'not-installed');
    assert.equal(readFileSync(fake,'utf8'),'FAKE POWERSHELL NOT EXECUTED');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
