/** AI-02 source contract: does not mutate Windows scheduled tasks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_HUB_RECOVERY_PS,
  SYSTEM_HUB_RECOVERY_LAUNCHER_PROOF_PS,
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
