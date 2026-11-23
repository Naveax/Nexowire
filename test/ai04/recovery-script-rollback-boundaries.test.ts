/** AI-02 source contract: does not mutate Windows scheduled tasks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_HUB_RECOVERY_PS,
  SYSTEM_HUB_RECOVERY_LAUNCHER_PROOF_PS,
  SYSTEM_HUB_RECOVERY_RESUME_TASK_PS,
} from '../../scripts/ai04-controlled-system-hub-cutover.js';

test('rollback only recognizes explicit durable journal phases',()=>{
  const allowed=[
    'ARMED','QUIESCING','QUIESCED','COPIED','RECEIPT_ISSUED',
    'SYSTEM_INSTALLING','SYSTEM_STARTED','HEALTHY',
    'AWAITING_PHYSICAL_ACCEPTANCE',
  ];
  for(const phase of allowed)assert.ok(SYSTEM_HUB_RECOVERY_PS.includes("'"+phase+"'"));
  assert.match(SYSTEM_HUB_RECOVERY_PS,/AI04_RECOVERY_UNKNOWN_PHASE/);
  assert.ok(!SYSTEM_HUB_RECOVERY_PS.includes("'UNKNOWN'"));
});

test('launcher proof hashes current and independently backed-up launcher',()=>{
  assert.match(SYSTEM_HUB_RECOVERY_LAUNCHER_PROOF_PS,/\$journal\.launcherSha256/);
  assert.match(SYSTEM_HUB_RECOVERY_LAUNCHER_PROOF_PS,/original-user-launcher\.ps1/);
  assert.match(SYSTEM_HUB_RECOVERY_LAUNCHER_PROOF_PS,/Get-FileHash/);
  assert.match(SYSTEM_HUB_RECOVERY_LAUNCHER_PROOF_PS,/AI04_RECOVERY_LEGACY_LAUNCHER_CHANGED/);
});

test('post-stop launcher replacement must be checked before SYSTEM unregister and legacy fallback',()=>{
  const script=SYSTEM_HUB_RECOVERY_PS;
  const stop=script.indexOf('Stop-ScheduledTask');
  const secondProof=script.indexOf('AI04_RECOVERY_LEGACY_LAUNCHER_CHANGED',stop);
  const resume=script.indexOf('Start-ScheduledTask',secondProof);
  const unregister=script.indexOf('Unregister-ScheduledTask',stop);
  const finalProof=script.indexOf('AI04_RECOVERY_LEGACY_LAUNCHER_CHANGED',unregister);
  const userTask=script.indexOf("$user=Get-ScheduledTask -TaskName 'Nexowire Hub'");
  assert.ok(stop>=0&&secondProof>stop&&resume>secondProof);
  assert.ok(unregister>resume&&finalProof>unregister&&userTask>finalProof);
  assert.match(script,/\$launcherDrift=\$_/);
  assert.match(script,/AI04_RECOVERY_SYSTEM_RESUME_FAILED/);
});

test('SYSTEM task restart rechecks principal, identity, exact executable and action',()=>{
  const source=SYSTEM_HUB_RECOVERY_RESUME_TASK_PS;
  assert.match(source,/AI04_RECOVERY_RESUME_TASK_CHANGED/);
  assert.match(source,/AI04_RECOVERY_RESUME_ACTION_CHANGED/);
  assert.match(source,/\$resumeTask\.Principal\.UserId/);
  assert.match(source,/\$resumeActions\[0\]\.Execute/);
  assert.match(source,/\$resumeActions\[0\]\.Arguments/);
  assert.equal(SYSTEM_HUB_RECOVERY_PS.split('AI04_RECOVERY_RESUME_ACTION_CHANGED').length-1,3);
  assert.equal(SYSTEM_HUB_RECOVERY_PS.split('AI04_RECOVERY_SYSTEM_RESUME_FAILED').length-1,2);
});

test('post-stop task action proof runs before unregister even when file states match',()=>{
  const script=SYSTEM_HUB_RECOVERY_PS;
  const current=script.indexOf("$current=Get-ScheduledTask -TaskName 'Nexowire Hub Boot'");
  const recheck=script.indexOf('AI04_RECOVERY_RESUME_ACTION_CHANGED',current);
  const unregister=script.indexOf('Unregister-ScheduledTask',current);
  assert.ok(current>=0&&recheck>current&&unregister>recheck);
});

test('durable state is revalidated after SYSTEM removal and before user fallback',()=>{
  const script=SYSTEM_HUB_RECOVERY_PS;
  const unregister=script.indexOf("Unregister-ScheduledTask -TaskName 'Nexowire Hub Boot'");
  const firstRecheck=script.indexOf('& $validateState',unregister);
  const absence=script.indexOf('AI04_RECOVERY_BOOT_STILL_REGISTERED_OR_HIDDEN',unregister);
  const legacy=script.indexOf("$user=Get-ScheduledTask -TaskName 'Nexowire Hub'");
  const secondRecheck=script.lastIndexOf('& $validateState',legacy);
  assert.ok(unregister>=0&&firstRecheck>unregister&&absence>firstRecheck);
  assert.ok(secondRecheck>absence&&legacy>secondRecheck);
});
