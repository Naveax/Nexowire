import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {postHealthSystemHubDisposition,runRecoverableSystemHubCutover,type SystemCutoverOperations} from '../src/hub/system-cutover-orchestrator.js';
import {SYSTEM_HUB_RECOVERY_PS} from '../scripts/ai04-controlled-system-hub-cutover.js';

test('a basic SYSTEM health check never counts as physical cutover acceptance',async()=>{
  const disposition=postHealthSystemHubDisposition();
  assert.deepEqual(disposition,{
    journalPhase:'AWAITING_PHYSICAL_ACCEPTANCE',
    retainRecoveryTask:true,physicalRebootAccepted:false,
  });
  const phases:string[]=[];
  const operations={
    preflight:async()=>{phases.push('preflight');},
    armRecovery:async()=>{phases.push('armRecovery');},
    confirmRecoveryBeforeQuiesce:async()=>{phases.push('confirmRecoveryBeforeQuiesce');},
    quiesceLegacy:async()=>{phases.push('quiesceLegacy');},
    copyProtectedState:async()=>{phases.push('copyProtectedState');},
    issueReceipt:async()=>{phases.push('issueReceipt');},
    installSystemHub:async()=>{phases.push('installSystemHub');},
    verifySystemHub:async()=>{phases.push('verifySystemHub');},
    commit:async()=>{phases.push('commit');},
    rollback:async()=>{phases.push('rollback');},
  } satisfies SystemCutoverOperations;
  const result=await runRecoverableSystemHubCutover(operations);
  assert.deepEqual(result,{
    booted:true,rollbackArmed:true,physicalRebootAccepted:false,
    pendingPhysicalAcceptance:true,
  });
  assert.equal(phases.at(-1),'commit');
  assert.equal(phases.includes('rollback'),false);
});

test('production commit cannot mark COMPLETE or disable recovery based on health only',()=>{
  const source=readFileSync(
    new URL('../scripts/ai04-controlled-system-hub-cutover.ts',import.meta.url),'utf8',
  );
  const match=source.match(/    async commit\(\)\{([\s\S]*?)\r?\n    \},/);
  assert.ok(match,'production cutover commit block missing');
  assert.match(match[1]!,/postHealthSystemHubDisposition\(\)/);
  assert.match(match[1]!,/advance\(journal,disposition\.journalPhase\)/);
  assert.doesNotMatch(match[1]!,/\bCOMPLETE\b|Disable-ScheduledTask|Unregister-ScheduledTask/);
});

test('armed recovery does not exit early while awaiting independent acceptance',()=>{
  assert.match(SYSTEM_HUB_RECOVERY_PS,
    /\$journal\.phase -in @\('COMPLETE','ROLLED_BACK'\)/);
  assert.doesNotMatch(
    SYSTEM_HUB_RECOVERY_PS.match(/if\(\$journal\.phase -in [^\r\n]+/)?.[0]??'',
    /AWAITING_PHYSICAL_ACCEPTANCE/,
  );
});
