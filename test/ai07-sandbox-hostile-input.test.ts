import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessTaskSandboxSourceOnly,
} from '../src/agent/task-os-sandbox-policy.js';
import {
  executeTaskWithOsSandbox,
  OsTaskSandboxBlockedError,
} from '../src/agent/task-os-sandbox-worker.js';

const sha = 'a'.repeat(64);
const valid = () => ({
  schema: 1, platform: 'win32', taskId: 'task1', originalRequestId: 'req1',
  ownerId: 'owner1', deviceId: 'dev1', ownerEpoch: 7,
  grantId: 'grant1', grantGeneration: 1,
  executableDigest: sha, baseWorktreeSha: sha, workerPrivilege: 'standard',
  args: ['--version'], envAllowlist: {},
  taskRoot: { canonicalPath: 'C:\\work', volumeOrMountIdentity: 'vol1',
    rootFileIdOrInode: 'fid1' },
  network: { default: 'deny', allowedEndpoints: [] },
  budgets: { cpuMs: 1000, wallMs: 2000, memoryBytes: 65536,
    maxProcesses: 2, outputBytes: 4096, diskBytes: 4096 },
});

test('AI-07 nested hostile accessors cannot run during source-only assessment', async () => {
  let invoked = 0;
  const access = () => { invoked++; throw new Error('ambient getter executed'); };
  const cases: unknown[] = [
    { ...valid(), get workerPrivilege() { return access(); } },
    { ...valid(), args: [Object.defineProperty({}, 'x', {get: access})] },
    { ...valid(), args: [1, 'safe'] },
    { ...valid(), args: ['safe', 'malformed\0arg'] },
    { ...valid(), taskRoot: { ...valid().taskRoot,
      canonicalPath: 'C:\\work\0truncated' } },
    { ...valid(), taskRoot: { ...valid().taskRoot,
      canonicalPath: 'x'.repeat(32768) } },
    { ...valid(), taskRoot: { ...valid().taskRoot,
      get canonicalPath() { return access(); } } },
    { ...valid(), budgets: { ...valid().budgets,
      get wallMs() { return access(); } } },
    { ...valid(), envAllowlist: { get SECRET() { return access(); } } },
    { ...valid(), network: { default: 'deny',
      get allowedEndpoints() { return access(); } } },
  ];
  const accessorArgs = ['--version'];
  Object.defineProperty(accessorArgs, '0', { get: access, configurable: true });
  cases.push({ ...valid(), args: accessorArgs });
  for (const intent of cases) {
    const decision = assessTaskSandboxSourceOnly(intent);
    assert.equal(decision.dispatchAllowed, false);
    assert.ok(decision.blockers.includes('INVALID_TASK_INTENT') ||
      decision.blockers.includes('PRIVILEGED_WORKER_FORBIDDEN') ||
      decision.blockers.includes('AMBIENT_ENVIRONMENT_FORBIDDEN') ||
      decision.blockers.includes('NETWORK_MUST_BE_DEFAULT_DENY') ||
      decision.blockers.includes('INVALID_RESOURCE_BUDGET'));
    await assert.rejects(executeTaskWithOsSandbox(intent),
      (e: unknown) => e instanceof OsTaskSandboxBlockedError);
  }
  assert.equal(invoked, 0);
});

test('AI-07 adversarial report accessors cannot claim physical cleanup or permission', () => {
  let invoked = 0;
  const report = {
    mutationState: 'completed',
    get brokerHandleInherited() { invoked++; throw Error('exposed handle'); },
    get descendantsContained() { invoked++; throw Error('claimed drain'); },
    get revokeDrainVerified() { invoked++; throw Error('claimed release'); },
  };
  const decision = assessTaskSandboxSourceOnly(valid(), report);
  assert.equal(invoked, 0);
  assert.equal(decision.status, 'RECONCILE_REQUIRED');
  assert.equal(decision.cleanupVerified, false);
  assert.equal(decision.dispatchAllowed, false);
  assert.equal(decision.mayReplayOriginalMutation, false);
});

test('AI-07 malformed or throwing Proxy reports deny instead of throwing', () => {
  const hostile = new Proxy({}, {getPrototypeOf() {throw Error('hostile report');}});
  const decision = assessTaskSandboxSourceOnly(valid(), hostile);
  assert.equal(decision.status, 'RECONCILE_REQUIRED');
  assert.equal(decision.dispatchAllowed, false);
  assert.equal(decision.mayReplayOriginalMutation, false);
  const invalidIntent = assessTaskSandboxSourceOnly(hostile, undefined);
  assert.equal(invalidIntent.status, 'BLOCKED');
  assert.equal(invalidIntent.dispatchAllowed, false);
  assert.ok(invalidIntent.blockers.includes('INVALID_TASK_INTENT'));
});

test('AI-07 inherited report mutation state is not accepted as a replay permit', () => {
  const inherited = Object.create({mutationState: 'not_started'});
  inherited.descendantsContained = true;
  inherited.revokeDrainVerified = true;
  const decision = assessTaskSandboxSourceOnly(valid(), inherited);
  assert.equal(decision.status, 'RECONCILE_REQUIRED');
  assert.equal(decision.dispatchAllowed, false);
  assert.equal(decision.mayReplayOriginalMutation, false);
});

test('AI-07 revoked Proxy objects and arrays fail closed without uncaught errors', async () => {
  const badTask = Proxy.revocable({}, {});
  badTask.revoke();
  const taskAssessment = assessTaskSandboxSourceOnly(badTask.proxy);
  assert.equal(taskAssessment.status, 'BLOCKED');
  assert.ok(taskAssessment.blockers.includes('INVALID_TASK_INTENT'));
  await assert.rejects(executeTaskWithOsSandbox(badTask.proxy),
    (e: unknown) => e instanceof OsTaskSandboxBlockedError);

  const badArgs = Proxy.revocable([], {});
  badArgs.revoke();
  const argsAssessment = assessTaskSandboxSourceOnly({
    ...valid(), args: badArgs.proxy,
  });
  assert.equal(argsAssessment.dispatchAllowed, false);
  assert.ok(argsAssessment.blockers.includes('INVALID_TASK_INTENT'));

  const badEndpoints = Proxy.revocable([], {});
  badEndpoints.revoke();
  const endpointAssessment = assessTaskSandboxSourceOnly({
    ...valid(), network: {default: 'deny', allowedEndpoints: badEndpoints.proxy},
  });
  assert.equal(endpointAssessment.dispatchAllowed, false);
  assert.ok(endpointAssessment.blockers.includes('NETWORK_MUST_BE_DEFAULT_DENY'));

  const badReport = Proxy.revocable({}, {});
  badReport.revoke();
  const reportAssessment = assessTaskSandboxSourceOnly(valid(), badReport.proxy);
  assert.equal(reportAssessment.status, 'RECONCILE_REQUIRED');
  assert.equal(reportAssessment.mayReplayOriginalMutation, false);
});

test('AI-07 aggregate argv and NUL native-truncation inputs are explicit INVALID_TASK_INTENT', async () => {
  const malformed = [
    { ...valid(), args: ['x'.repeat(32768)] },
    { ...valid(), args: ['x'.repeat(20000), 'y'.repeat(20000)] },
    { ...valid(), args: ['x', 'evil' + String.fromCharCode(0) + 'suffix'] },
    { ...valid(), taskRoot: { ...valid().taskRoot, canonicalPath: 'root' + String.fromCharCode(0) + 'other' } },
    { ...valid(), taskRoot: { ...valid().taskRoot, canonicalPath: 'x'.repeat(32768) } },
  ];
  for (const task of malformed) {
    const assessment = assessTaskSandboxSourceOnly(task);
    assert.equal(assessment.status, 'BLOCKED');
    assert.equal(assessment.dispatchAllowed, false);
    assert.equal(assessment.mayReplayOriginalMutation, false);
    assert.ok(assessment.blockers.includes('INVALID_TASK_INTENT'),
      'invalid argv/path must be classified, not merely denied for missing native provider');
    await assert.rejects(executeTaskWithOsSandbox(task),
      (e: unknown) => e instanceof OsTaskSandboxBlockedError &&
        e.safeBlueprint.assessment.blockers.includes('INVALID_TASK_INTENT'));
  }
});


test('AI-07 argv rejects extra hidden or symbolic own fields without evaluating accessors', async () => {
  let getterRuns=0;
  const hidden=['--version'];
  Object.defineProperty(hidden,'hiddenSecret',{
    configurable:true,enumerable:false,
    get(){getterRuns++;throw new Error('untrusted hidden argv getter');},
  });
  const symbolic=['--version'];
  Object.defineProperty(symbolic,Symbol('secret-token'),{
    value:'fixture-only',enumerable:false,configurable:true,
  });
  const extra=['--version'];
  Object.defineProperty(extra,'nonIndexed',{value:'ignored-if-not-checked'});

  const blockedOwnKeys=Proxy.revocable(['--version'],{
    ownKeys(){throw Error('adversarial argv reflection');},
  });
  for(const args of [hidden,symbolic,extra,blockedOwnKeys.proxy]){
    const input={...valid(),args};
    const result=assessTaskSandboxSourceOnly(input);
    assert.equal(result.status,'BLOCKED');
    assert.equal(result.dispatchAllowed,false);
    assert.equal(result.mayReplayOriginalMutation,false);
    assert.ok(result.blockers.includes('INVALID_TASK_INTENT'),
      'additional argv keys and reflection failures must invalidate input shape');
    await assert.rejects(executeTaskWithOsSandbox(input),
      (error:unknown)=>error instanceof OsTaskSandboxBlockedError &&
        error.safeBlueprint.assessment.blockers.includes('INVALID_TASK_INTENT'));
  }
  assert.equal(getterRuns,0,'hidden own accessor must not be invoked');
});
