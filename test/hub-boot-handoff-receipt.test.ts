import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {classifyHubBootHandoffFailure} from '../src/hub/hub-boot-lifecycle.js';

const source=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
const install=source.slice(
  source.indexOf('export async function installHubBootLifecycle('),
  source.indexOf('export async function uninstallHubBootLifecycle('),
);
const ps=String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const failure=(legacyMutationAttempted:boolean,systemStartAttempted:boolean)=>({
  ok:false,legacyMutationAttempted,systemStartAttempted,error:'SYNTHETIC_FAILURE',
});

test('known pre-handoff failures cannot undo a concurrently changed legacy task',()=>{
  assert.equal(classifyHubBootHandoffFailure(failure(false,false)),'rollback-boot-only');
  assert.equal(classifyHubBootHandoffFailure(failure(true,false)),'rollback-boot-and-legacy');
});

test('lost or malformed receipts and every attempted SYSTEM startup preserve recovery evidence',()=>{
  for(const value of [
    null,undefined,{},true,{ok:true},
    {ok:false,legacyMutationAttempted:false,systemStartAttempted:false},
    {...failure(false,false),legacyMutationAttempted:'false'},
    {...failure(false,false),systemStartAttempted:'false'},
    {...failure(false,false),error:''},
    {...failure(false,false),unexpected:true},
    {ok:true,legacyMutationAttempted:true,systemStartAttempted:false},
    failure(false,true),failure(true,true),
    {ok:true,legacyMutationAttempted:true,systemStartAttempted:true},
  ]){
    assert.equal(classifyHubBootHandoffFailure(value),'preserve-for-recovery',JSON.stringify(value));
  }
});

test('production transaction records attempts before side effects and denies automatic recovery on unknown outcome',()=>{
  const registration=install.indexOf('Register-ScheduledTask -TaskName $boot');
  const race=install.indexOf('HUB_USER_TASK_STATE_RACE',registration);
  const legacyAttempt=install.indexOf('$legacyMutationAttempted=$true',race);
  const stop=install.indexOf('Stop-ScheduledTask -TaskName $user',legacyAttempt);
  const port=install.indexOf('HUB_LEGACY_PORT_STILL_OWNED',stop);
  const systemAttempt=install.indexOf('$systemStartAttempted=$true',port);
  const start=install.indexOf('Start-ScheduledTask -TaskName $boot',systemAttempt);
  const receipt=install.indexOf('ok=$true;legacyMutationAttempted=$legacyMutationAttempted',start);
  const failureReceipt=install.indexOf('ok=$false;legacyMutationAttempted=$legacyMutationAttempted',receipt);
  const wait=install.indexOf('await waitForBootHub',failureReceipt);
  const preserve=install.indexOf("disposition==='preserve-for-recovery'",wait);
  const throwPreserve=install.indexOf('HUB_BOOT_HANDOFF_RECOVERY_REQUIRED',preserve);
  const rollback=install.indexOf('Stop-ScheduledTask -TaskName $boot',throwPreserve);
  const restore=install.indexOf('if($userTask -and $restoreLegacyState)',rollback);
  const enable=install.indexOf('Enable-ScheduledTask -TaskName $user',restore);
  const cleanup=install.indexOf('await fs.rm(p.root',enable);
  const order=[registration,race,legacyAttempt,stop,port,systemAttempt,start,receipt,
    failureReceipt,wait,preserve,throwPreserve,rollback,restore,enable,cleanup];
  assert.ok(order.every((value,i)=>value>=0&&(i===0||value>order[i-1]!)),String(order));
  assert.match(install,/handoffReceipt=HubBootHandoffReceiptSchema\.parse\(await runPowerShellJson<unknown>/);
  assert.match(install,/if\(!handoffReceipt\.ok\)throw new Error\(handoffReceipt\.error\)/);
  assert.match(install,/\$restoreLegacyState='\+\(disposition==='rollback-boot-and-legacy'\?/);
});

function exactLine(fragment:string):string{
  const line=install.split('\n').find(value=>value.trim().startsWith('"')&&value.includes(fragment));
  assert.ok(line,fragment);
  return JSON.parse(line.trim().replace(/,$/,''));
}

test('Windows synthetic transaction returns the actual receipt fields for each interrupted stage',{
  skip:process.platform!=='win32',
},()=>{
  const initLegacy=exactLine('$legacyMutationAttempted=$false');
  const initSystem=exactLine('$systemStartAttempted=$false');
  const compare=exactLine('if($actualLegacyState -cne $expectedLegacyState)');
  const attemptLegacy=exactLine('$legacyMutationAttempted=$true');
  const attemptSystem=exactLine('$systemStartAttempted=$true');
  const success=exactLine('ok=$true;legacyMutationAttempted=');
  const failed=exactLine('ok=$false;legacyMutationAttempted=');
  const scenarios=[
    {label:'concurrent disable',actual:'Disabled',legacy:false,system:false,ok:false,failAt:'',expected:'rollback-boot-only'},
    {label:'concurrent ready',actual:'Ready',legacy:false,system:false,ok:false,failAt:'',expected:'rollback-boot-only'},
    {label:'attempted legacy stop fails',actual:'Running',legacy:true,system:false,ok:false,failAt:'legacy',expected:'rollback-boot-and-legacy'},
    {label:'attempted SYSTEM start fails',actual:'Running',legacy:true,system:true,ok:false,failAt:'system',expected:'preserve-for-recovery'},
    {label:'SYSTEM start completed',actual:'Running',legacy:true,system:true,ok:true,failAt:'',expected:'preserve-for-recovery'},
  ] as const;
  for(const item of scenarios){
    const script=[
      "$ErrorActionPreference='Stop'",
      "$expectedLegacyState='Running'",
      "$actualLegacyState='"+item.actual+"'",
      initLegacy,initSystem,'try {',compare,attemptLegacy,
      item.failAt==='legacy'?"throw 'FIXTURE_LEGACY_STOP'":'',
      attemptSystem,
      item.failAt==='system'?"throw 'FIXTURE_SYSTEM_START'":'',
      success,'} catch {',failed,'}',
    ].join('\n');
    // Only source-derived assignments, conditionals and JSON serialization.
    // No Task Scheduler command, real task, path or credential is touched.
    assert.doesNotMatch(script,/(?:Get|Set|Register|Unregister|Enable|Disable|Start|Stop)-ScheduledTask/);
    const child=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(child.status,0,item.label+': '+child.stderr);
    const receipt=JSON.parse(child.stdout);
    assert.equal(receipt.ok,item.ok,item.label);
    assert.equal(receipt.legacyMutationAttempted,item.legacy,item.label);
    assert.equal(receipt.systemStartAttempted,item.system,item.label);
    assert.equal(classifyHubBootHandoffFailure(receipt),item.expected,item.label);
  }
});
