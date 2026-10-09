import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  isolatedPrivilegedBrokerTaskEnvironment,
  privilegedBrokerTaskStatus,
} from '../src/agent/privileged-broker-lifecycle.js';

test('elevated broker lifecycle shell has only pinned OS and task environment',()=>{
  const env=isolatedPrivilegedBrokerTaskEnvironment({
    NEXOWIRE_BROKER_TASK_NAME:'Nexowire Privileged Broker',
    NEXOWIRE_BROKER_LAUNCHER:'C:\\ProgramData\\Nexowire\\privileged-broker\\launch.ps1',
    PATH:'C:\\writable\\fakebin',
    PSModulePath:'C:\\writable\\modules',
    NODE_OPTIONS:'--require C:\\writable\\inject.js',
    GH_HOST:'malicious.invalid',
    APPDATA:'C:\\Users\\caller\\AppData',
    TEMP:'C:\\Users\\caller\\Temp',
  });
  assert.deepEqual(env,{
    SystemRoot:'C:\\Windows',
    windir:'C:\\Windows',
    ComSpec:'C:\\Windows\\System32\\cmd.exe',
    PATH:'C:\\Windows\\System32;C:\\Windows',
    PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    NEXOWIRE_BROKER_TASK_NAME:'Nexowire Privileged Broker',
    NEXOWIRE_BROKER_LAUNCHER:'C:\\ProgramData\\Nexowire\\privileged-broker\\launch.ps1',
  });
  assert.equal((env as NodeJS.ProcessEnv).NODE_OPTIONS,undefined);
  assert.equal((env as NodeJS.ProcessEnv).APPDATA,undefined);
});
test('elevated broker task environment rejects absent or oversized task parameters',()=>{
  assert.throws(()=>isolatedPrivilegedBrokerTaskEnvironment({
    NEXOWIRE_BROKER_TASK_NAME:'',NEXOWIRE_BROKER_LAUNCHER:'C:\\launch.ps1',
  }),/PRIVILEGED_BROKER_TASK_ENV_INVALID/);
  assert.throws(()=>isolatedPrivilegedBrokerTaskEnvironment({
    NEXOWIRE_BROKER_TASK_NAME:'x'.repeat(129),NEXOWIRE_BROKER_LAUNCHER:'C:\\launch.ps1',
  }),/PRIVILEGED_BROKER_TASK_ENV_INVALID/);
  assert.throws(()=>isolatedPrivilegedBrokerTaskEnvironment({
    NEXOWIRE_BROKER_TASK_NAME:'Test',NEXOWIRE_BROKER_LAUNCHER:'x'.repeat(4097),
  }),/PRIVILEGED_BROKER_TASK_ENV_INVALID/);
});
test('broker PowerShell interpreter and future Scheduled Task action are fully qualified',()=>{
  const source=readFileSync(new URL('../src/agent/privileged-broker-lifecycle.ts',import.meta.url),'utf8');
  assert.ok(source.includes("BROKER_TASK_POWERSHELL=BROKER_TASK_SYSTEM32+'\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"));
  assert.ok(source.includes("Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\ScheduledTasks\\ScheduledTasks.psd1'"));
  assert.ok(source.includes("spawn(\n      BROKER_TASK_POWERSHELL,"));
  assert.ok(source.includes('env:isolatedPrivilegedBrokerTaskEnvironment(env)'));
  assert.ok(source.includes('cwd:BROKER_TASK_SYSTEM32'));
  assert.ok(source.includes('shell:false'));
  assert.ok(source.includes("New-ScheduledTaskAction -Execute 'C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"));
  assert.ok(!source.includes("spawn(\n      'powershell.exe'"));
  assert.ok(!source.includes('...process.env,\n          ...env'));
});
test('actual read-only broker task status ignores fake PATH-resolved PowerShell and modules',{
  skip:process.platform!=='win32',
},async()=>{
  const tmp=mkdtempSync(path.join(tmpdir(),'nx-broker-task-shell-spoof-'));
  const fake=path.join(tmp,'powershell.exe');
  writeFileSync(fake,'not-a-Windows-PE-executable');
  try {
    const taskName='NX-readonly-broker-shell-check-'+process.pid;
    const state=await privilegedBrokerTaskStatus({
      taskName,
      env:{
        ...process.env,
        PATH:tmp+';'+(process.env.PATH||''),
        PSModulePath:tmp,
        NODE_OPTIONS:'--require '+path.join(tmp,'inject.js'),
      },
    });
    assert.equal(state.taskName,taskName);
    assert.equal(state.installed,false);
    assert.equal(state.state,null);
    assert.equal(readFileSync(fake,'utf8'),'not-a-Windows-PE-executable');
  } finally {rmSync(tmp,{recursive:true,force:true});}
});
