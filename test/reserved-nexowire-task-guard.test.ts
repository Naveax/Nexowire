import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  assertGenericTaskActivationAllowed,
  executeWindowsCapability,
} from '../src/agent/windows-control.js';

test('protected Nexowire task names cannot use general Scheduled Task mutations',async()=>{
  const reserved=[
    'Nexowire Privileged Broker',
    'NEXOWIRE PRIVILEGED BROKER',
    ' nexowire privileged broker ',
    'Nexowire Stack',
    '  NEXOWIRE STACK  ',
  ];
  for(const name of reserved){
    for(const action of ['start','enable'] as const) {
      assert.throws(
        ()=>assertGenericTaskActivationAllowed(name,action),
        /NEXOWIRE_RESERVED_TASK_REQUIRES_PROTECTED_LIFECYCLE/,
      );
      if(process.platform==='win32'){
        await assert.rejects(
          executeWindowsCapability('windows.task.control',{
            name,path:'\\',action,
          }),
          /NEXOWIRE_RESERVED_TASK_REQUIRES_PROTECTED_LIFECYCLE/,
        );
      }
    }
    // Never execute an actual task stop in this test. Only check local guard.
    assert.doesNotThrow(()=>assertGenericTaskActivationAllowed(name,'stop'));
    assert.doesNotThrow(()=>assertGenericTaskActivationAllowed(name,'disable'));
  }
  assert.doesNotThrow(()=>assertGenericTaskActivationAllowed('Custom Backup Task','start'));
  assert.doesNotThrow(()=>assertGenericTaskActivationAllowed('Nexowire User Test Task','enable'));
});

test('Windows PowerShell also guards reserved tasks before any Scheduled Task lookup',()=>{
  const source=readFileSync(
    new URL('../src/agent/windows-control.ts',import.meta.url),'utf8',
  );
  const script=source.slice(
    source.indexOf('const scheduledTaskControlScript = String.raw'),
    source.indexOf('const firewallControlScript = String.raw'),
  );
  const guard=script.indexOf('NEXOWIRE_RESERVED_TASK_REQUIRES_PROTECTED_LIFECYCLE');
  const lookup=script.indexOf('Get-ScheduledTask -ErrorAction Stop');
  const stop=script.indexOf('Stop-ScheduledTask');
  assert.ok(guard>0 && guard<lookup && guard<stop);
  assert.match(script,/Nexowire Privileged Broker/);
  assert.match(script,/Nexowire Stack/);
  assert.doesNotMatch(script,/Register-ScheduledTask|Unregister-ScheduledTask/);
});
