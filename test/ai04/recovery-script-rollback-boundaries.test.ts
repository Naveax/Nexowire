/** AI-02 source contract: does not mutate Windows scheduled tasks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  SYSTEM_HUB_RECOVERY_PS,
  SYSTEM_HUB_RECOVERY_LAUNCHER_PROOF_PS,
  SYSTEM_HUB_RECOVERY_RESUME_TASK_PS,
  assertRecoveryArtifactPresent,
  assertDurableRollbackConfirmation,
  SYSTEM_HUB_ROLLBACK_TIMEOUT_MS,
  decodeCutoverLauncherProof,
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
  const canonicalGuard=SYSTEM_HUB_RECOVERY_PS.split(/\r?\n/).find(line=>
    line.includes('AI04_RECOVERY_UNKNOWN_PHASE'));
  assert.ok(canonicalGuard);
  assert.ok(canonicalGuard.includes('[string]$journal.phase -cnotin'));
  for(const phase of [...allowed,'COMPLETE','ROLLED_BACK'])
    assert.ok(canonicalGuard.includes("'"+phase+"'"));
  const terminalExit="if($journal.phase -in @('COMPLETE','ROLLED_BACK')){exit 0}";
  assert.ok(SYSTEM_HUB_RECOVERY_PS.includes(terminalExit));
  assert.ok(SYSTEM_HUB_RECOVERY_PS.indexOf(canonicalGuard)<
    SYSTEM_HUB_RECOVERY_PS.indexOf(terminalExit));
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

test('missing or nonregular rollback artifact is an error, not recovery success',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-ai02-recovery-artifact-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'rollback.ps1');
  await assert.rejects(()=>assertRecoveryArtifactPresent(file),/AI04_ROLLBACK_ARTIFACT_MISSING/);
  await fs.mkdir(file);
  await assert.rejects(()=>assertRecoveryArtifactPresent(file),/AI04_ROLLBACK_ARTIFACT_UNTRUSTED/);
  await fs.rmdir(file);
  await fs.writeFile(file,'# inert fixture');
  await assertRecoveryArtifactPresent(file);
  const alias=path.join(root,'alias.ps1');
  await fs.link(file,alias);
  await assert.rejects(()=>assertRecoveryArtifactPresent(file),/AI04_ROLLBACK_ARTIFACT_UNTRUSTED/);
});

test('launcher proof hashes exact bytes including BOM, Unicode and CRLF',()=>{
  const bytes=Buffer.from('\uFEFF# fixture Çığ\r\n','utf8');
  const proof=decodeCutoverLauncherProof(bytes);
  assert.equal(proof.raw,bytes.toString('utf8'));
  assert.equal(proof.digest,createHash('sha256').update(bytes).digest('hex'));
  const lossy=Buffer.from([0x23,0x80,0xff]);
  assert.throws(()=>decodeCutoverLauncherProof(lossy),/AI04_LEGACY_LAUNCHER_ENCODING_UNTRUSTED/);
  assert.notEqual(decodeCutoverLauncherProof(Buffer.from('# fixture\n')).digest,
    decodeCutoverLauncherProof(Buffer.from('# fixture\r\n')).digest);
});

test('Windows negative fixture shadows every scheduler, COM, CIM and HTTP command used by recovery',()=>{
  const fixture=readFileSync(new URL('../system-hub-recovery-failure-injection.test.ts',import.meta.url),'utf8');
  for(const command of [
    'Get-ScheduledTask','Stop-ScheduledTask','Start-ScheduledTask','Unregister-ScheduledTask',
    'Enable-ScheduledTask','Get-NetTCPConnection','New-Object','Get-CimInstance',
    'Invoke-CimMethod','Invoke-WebRequest',
  ]){
    assert.ok(SYSTEM_HUB_RECOVERY_PS.includes(command),command+' no longer used; review fixture scope');
    assert.ok(fixture.includes('function '+command+' '),command+' must be locally shadowed');
  }
  assert.ok(fixture.includes('AI04_FIXTURE_UNEXPECTED_OS_CALL'));
  assert.ok(fixture.includes('AI04_FIXTURE_UNEXPECTED_TASK'));
});

test('rollback confirmation accepts UTF-8 BOM but requires the exact durable transaction',()=>{
  const expected={
    version:1 as const,host:'FIXTURE',marker:'fixture-transaction',
    sourceRoot:'fixture-source',launcherPath:'fixture-launcher',
    launcherSha256:'a'.repeat(64),port:43110,
    originalUserPrincipal:'fixture-user',createdAt:'2026-11-24T00:00:00.000Z',
  };
  const terminal={...expected,phase:'ROLLED_BACK'};
  const raw=Buffer.from(JSON.stringify(terminal),'utf8');
  const bom=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),raw]);
  assertDurableRollbackConfirmation(raw,expected);
  assertDurableRollbackConfirmation(bom,expected);
  for(const key of Object.keys(expected) as (keyof typeof expected)[]){
    assert.throws(()=>assertDurableRollbackConfirmation(Buffer.from(JSON.stringify({
      ...terminal,[key]:null,
    })),expected),/AI04_ROLLBACK_DURABLE_CONFIRMATION_MISSING/);
  }
  for(const phase of ['COMPLETE','AWAITING_PHYSICAL_ACCEPTANCE','rolled_back']){
    assert.throws(()=>assertDurableRollbackConfirmation(Buffer.from(JSON.stringify({
      ...terminal,phase,
    })),expected),/AI04_ROLLBACK_DURABLE_CONFIRMATION_MISSING/);
  }
  for(const invalid of [Buffer.from([0xff]),Buffer.from('{'),Buffer.from('null'),
    Buffer.from('[]'),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),bom])]){
    assert.throws(()=>assertDurableRollbackConfirmation(invalid,expected),
      /AI04_ROLLBACK_DURABLE_CONFIRMATION_MISSING/);
  }
});

test('manual rollback and scheduled rollback use the same bounded execution budget',()=>{
  const waits=[...SYSTEM_HUB_RECOVERY_PS.matchAll(/\.AddSeconds\((\d+)\)/g)]
    .map(match=>Number(match[1])*1000);
  assert.deepEqual(waits,[45_000,20_000,30_000]);
  assert.ok(SYSTEM_HUB_ROLLBACK_TIMEOUT_MS>waits.reduce((sum,ms)=>sum+ms,0));
  assert.equal(SYSTEM_HUB_ROLLBACK_TIMEOUT_MS,300_000);
  const source=readFileSync(new URL('../../scripts/ai04-controlled-system-hub-cutover.ts',import.meta.url),'utf8');
  assert.ok(source.includes("runPS('& '+psLiteral(RECOVERY),SYSTEM_HUB_ROLLBACK_TIMEOUT_MS)"));
  assert.ok(source.includes('timeout:timeoutMs'));
  assert.ok(source.includes('New-TimeSpan -Seconds "+(SYSTEM_HUB_ROLLBACK_TIMEOUT_MS/1000)+'));
  assert.ok(source.includes('TASK_READBACK_TIMEOUT_MS=45_000'));
});

test('cutover and manual/scheduled recovery share a protected OS handle boundary',()=>{
  const source=readFileSync(new URL('../../scripts/ai04-controlled-system-hub-cutover.ts',import.meta.url),'utf8');
  const arm=source.indexOf('async armRecovery(){');
  const lock=source.indexOf("await privateWrite(CUTOVER_LOCK,'')",arm);
  const hold=source.indexOf("cutoverLock=await fs.open(CUTOVER_LOCK,'r+')",lock);
  const register=source.indexOf('Register-ScheduledTask',hold);
  assert.ok(arm>=0&&lock>arm&&hold>lock&&register>hold);
  const ps=SYSTEM_HUB_RECOVERY_PS;
  const exclusive=ps.indexOf('[IO.FileShare]::None');
  assert.ok(exclusive>=0&&exclusive<ps.indexOf('$journal=Get-Content'));
  assert.ok(ps.indexOf('AI04_RECOVERY_LOCK_UNAVAILABLE')<ps.indexOf('Stop-ScheduledTask'));
  assert.ok(ps.indexOf('$recoveryLock.Dispose()')>ps.indexOf('Move-Item -LiteralPath $temp'));
  const rollback=source.slice(source.indexOf('async rollback(){'));
  assert.ok(rollback.indexOf('await assertCutoverLockHeld()')<rollback.indexOf('await releaseCutoverLock()'));
  assert.ok(rollback.indexOf('await releaseCutoverLock()')<rollback.indexOf('runRollbackScript()'));
  assert.match(source,/finally\{\s*try\{await releaseCutoverLock\(\)\}/);
  assert.doesNotMatch(ps,/Remove-Item[^\r\n]*\$lockPath/);
});

test('ARMED recovery cannot touch tasks before any quiescence attempt',()=>{
  const ps=SYSTEM_HUB_RECOVERY_PS;
  const armed=ps.indexOf("if([string]$journal.phase -ceq 'ARMED'){throw 'AI04_RECOVERY_QUIESCE_NOT_ATTEMPTED'}");
  const journal=ps.indexOf('$journal=Get-Content');
  const taskRead=ps.indexOf('Get-ScheduledTask');
  assert.ok(journal>=0&&armed>journal&&taskRead>armed);
  for(const command of ['Stop-ScheduledTask','Unregister-ScheduledTask','Enable-ScheduledTask','Start-ScheduledTask'])
    assert.ok(ps.indexOf(command)>armed);
});
