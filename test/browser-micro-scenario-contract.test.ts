import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {executeBrowserCapability,type BrowserRuntime}
  from '../src/agent/browser-control.js';
import {
  BrowserMicroScenarioPlanV1Schema,
  reviewBrowserMicroScenarioPlan,
  reviewBrowserMicroScenarioScreenshotRef,
  reviewBrowserMicroScenarioStepBoundary,
} from '../src/agent/browser-micro-scenario-contract.js';

function fixture(){
  return {
    version:1 as const,taskId:'task-a',logicalMutationId:randomUUID(),
    requestId:randomUUID(),ownerId:randomUUID(),deviceId:randomUUID(),
    deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),
    ownerEpoch:3,grantGeneration:5,taskGrantId:randomUUID(),
    worktreeGrantId:randomUUID(),sandboxId:randomUUID(),
    worktreeBaseSha:'a'.repeat(40),worktreeDiffSha:'b'.repeat(64),
    semanticEffectSha256:'c'.repeat(64),worktreeIdentitySha256:'d'.repeat(64),
    preimageSha256:'e'.repeat(64),baseSha256:'f'.repeat(64),
    browserSessionId:randomUUID(),targetId:'page-1',
    allowedOrigin:'https://example.com',maxDurationMs:20_000,
    maxEvidenceBytes:250_000,journalState:'PLANNED' as const,
    steps:[
      {op:'navigate' as const,id:'n',url:'https://example.com/a',timeoutMs:5_000},
      {op:'wait' as const,id:'w',readyState:'complete' as const,timeoutMs:2_000},
      {op:'assert' as const,id:'a',selector:'#status',
        expectedText:'ready',textMode:'exact' as const},
      {op:'screenshot' as const,id:'s',maxBytes:130_000},
    ],
  };
}
test('existing four CDP primitives have only an inert, bounded source plan',()=>{
  const x=fixture(),r=reviewBrowserMicroScenarioPlan(x);
  assert.equal(BrowserMicroScenarioPlanV1Schema.safeParse(x).success,true);
  assert.equal(r.status,'SOURCE_PLAN_ONLY');
  assert.equal(r.stepCount,4);
  assert.equal(r.canDispatch,false);
  assert.equal(r.canElevate,false);
  assert.equal(r.canReplay,false);
  assert.equal(r.evidenceVerified,false);
  assert.equal(r.physicalStopVerified,false);
  assert.equal(Object.isFrozen(r),true);
  assert.equal('execute'in r,false);
});
test('UNKNOWN journal source retains identity/error and cannot replay',()=>{
  const x={...fixture(),journalState:'MUTATION_STATE_UNKNOWN' as const,
    originalErrorCode:'MUTATION_STATE_UNKNOWN'};
  const r=reviewBrowserMicroScenarioPlan(x);
  assert.equal(r.status,'RECONCILE_REQUIRED');
  assert.equal(r.requestId,x.requestId);
  assert.equal(r.logicalMutationId,x.logicalMutationId);
  assert.equal(r.originalErrorCode,'MUTATION_STATE_UNKNOWN');
  assert.equal(r.safeNextAction,'READ_ONLY_RECONCILIATION');
  assert.equal(r.canReplay,false);
});
test('copied grant, simulated approved=true, CORE and raw script fields rejected',()=>{
  const x=fixture();
  for(const added of [
    {approved:true},{signedGrant:true},{coreEffective:true},
    {command:'powershell -Verb RunAs'},
    {script:'window.top.document.body.innerHTML=""'},
    {worktreeRoot:'C:\\Users\\private'}, {ownerGrant:{verified:true}},
    {clientCanDispatch:true},{apiToken:'not-a-token'},
  ])assert.equal(BrowserMicroScenarioPlanV1Schema.safeParse({...x,...added}).success,false);
});
test('stale or malformed owner/worktree/sandbox scope is never execution proof',()=>{
  const x=fixture();
  for(const broken of [
    {ownerEpoch:-1},{grantGeneration:0},{ownerId:'attacker'},
    {worktreeBaseSha:'stale'},{worktreeDiffSha:'bad'},
    {taskGrantId:'fake'},{sandboxId:'fake'},
    {browserSessionId:'fake'},
  ])assert.equal(BrowserMicroScenarioPlanV1Schema.safeParse({...x,...broken}).success,false);
  for(const changed of [
    {ownerEpoch:x.ownerEpoch+1},{grantGeneration:x.grantGeneration+1},
    {worktreeBaseSha:'c'.repeat(40)},{taskGrantId:randomUUID()},
  ]){
    const r=reviewBrowserMicroScenarioPlan({...x,...changed});
    assert.equal(r.canDispatch,false,'client-provided freshness never grants authority');
  }
});
test('unsupported click, evaluate, UAC, upload and generic waits are not steps',()=>{
  const x=fixture();
  for(const op of ['click','set_value','evaluate','uac','upload','network']) {
    const steps=[{op,id:'forbidden',selector:'#button'}];
    assert.equal(BrowserMicroScenarioPlanV1Schema.safeParse({...x,steps}).success,false);
  }
  const wait=[{op:'wait',id:'first',readyState:'complete',timeoutMs:200}];
  assert.throws(()=>reviewBrowserMicroScenarioPlan({...x,steps:wait}),
    /WAIT_WITHOUT_NAVIGATION/);
});
test('cross-origin, credentials, public HTTP and JavaScript navigation denied',()=>{
  const x=fixture();
  for(const url of [
    'https://attacker.example/a','http://example.com/',
    'javascript:alert(1)','https://alice:secret@example.com/',
    'file:///C:/Users/user/secrets','https://example.com.evil.test/',
  ]){
    assert.throws(()=>reviewBrowserMicroScenarioPlan({...x,
      steps:[{op:'navigate',id:'n',url,timeoutMs:1_000}]}));
  }
});
test('bounded steps and cumulative screenshot/time budgets fail closed',()=>{
  const x=fixture();
  assert.equal(BrowserMicroScenarioPlanV1Schema.safeParse({...x,
    steps:Array.from({length:9},(_,i)=>({
      op:'navigate',id:'n'+i,url:'https://example.com',timeoutMs:1_000,
    }))}).success,false);
  assert.throws(()=>reviewBrowserMicroScenarioPlan({...x,
    maxDurationMs:2_000}),/BUDGET_EXCEEDED/);
  assert.throws(()=>reviewBrowserMicroScenarioPlan({...x,
    maxEvidenceBytes:65_536}),/BUDGET_EXCEEDED/);
  assert.throws(()=>reviewBrowserMicroScenarioPlan({...x,steps:[
    {op:'navigate',id:'n',url:'https://example.com',timeoutMs:1_000},
    {op:'navigate',id:'n',url:'https://example.com',timeoutMs:1_000},
  ]}),/DUPLICATE_STEP/);
});
test('verified SHA-format screenshot metadata still does not attest physical capture',()=>{
  const x=fixture(),e={taskId:x.taskId,requestId:x.requestId,
    browserSessionId:x.browserSessionId,targetId:x.targetId,
    stepId:'s',sha256:'a'.repeat(64),mimeType:'image/png',
    bytes:120_000,width:800,height:600};
  const r=reviewBrowserMicroScenarioScreenshotRef(x,e);
  assert.equal(r.status,'SOURCE_METADATA_ONLY');
  assert.equal(r.evidenceVerified,false);
  assert.equal(r.canDispatch,false);
  for(const bad of [
    {requestId:randomUUID()},{targetId:'foreign-target'},
    {browserSessionId:randomUUID()},{sha256:'spoofed'},
    {bytes:250_001},{bytes:130_001},{stepId:'a'},
    {mimeType:'text/html'}, {captured:true},
  ])assert.throws(()=>reviewBrowserMicroScenarioScreenshotRef(x,{...e,...bad}));
});
test('micro-scenario has no exposed browser capability and cannot call existing CDP',async()=>{
  let calls=0;
  const runtime=new Proxy({},{
    get(){return (..._args:unknown[])=>{calls++;throw new Error('CDP dispatch forbidden');};},
  }) as BrowserRuntime;
  await assert.rejects(executeBrowserCapability('browser.micro_scenario',fixture(),runtime),
    /Unsupported browser capability/);
  assert.equal(calls,0);
});

/**
 * ONE scoped API-compatibility negative, across #783 Journal's original
 * logical mutation identity and #795's task/worktree semantic readback.
 * The progress list is synthetic metadata, NOT an actual CDP operation.
 */
test('#783/#795 continuation: owner/worktree drift, revoke or UNKNOWN stops before next CDP step',()=>{
  const plan=fixture();
  const trustedShape=()=>({
    taskBinding:{
      taskId:plan.taskId,logicalMutationId:plan.logicalMutationId,
      ownerId:plan.ownerId,deviceId:plan.deviceId,
      deviceEpoch:plan.deviceEpoch,sessionEpoch:plan.sessionEpoch,
      ownerEpoch:plan.ownerEpoch,grantGeneration:plan.grantGeneration,
      semanticEffectSha256:plan.semanticEffectSha256,
      worktreeIdentitySha256:plan.worktreeIdentitySha256,
      preimageSha256:plan.preimageSha256,
      baseSha256:plan.baseSha256,diffSha256:plan.worktreeDiffSha,
      gitRootWithinApprovedScope:true,gitMetadataWithinApprovedScope:true,
      mutationState:'NOT_DISPATCHED_VERIFIED' as const,
    },
    ownerFence:{
      ownerEpoch:plan.ownerEpoch,grantGeneration:plan.grantGeneration,
      revoking:false,revoked:false,
    },
    journal:{
      logicalMutationId:plan.logicalMutationId,requestId:plan.requestId,
      state:'PLANNED' as const,
    },
    browserSessionId:plan.browserSessionId,targetId:plan.targetId,
  });
  // An apparent initial match is NOT a signed grant; even the first
  // navigate remains blocked. We simulate only source metadata progression.
  const initial=reviewBrowserMicroScenarioStepBoundary(plan,'n',trustedShape());
  assert.equal(initial.status,'SOURCE_SCOPE_MATCHED_NO_AUTHORITY');
  assert.equal(initial.canDispatch,false);
  assert.equal(initial.canAdvance,false);
  const scenarios=[
    {name:'re-pair ownerEpoch',next:'a',
      change:{ownerFence:{...trustedShape().ownerFence,
        ownerEpoch:plan.ownerEpoch+1}},expected:'STOP'},
    {name:'linked worktree identity SHA',next:'s',
      change:{taskBinding:{...trustedShape().taskBinding,
        worktreeIdentitySha256:'9'.repeat(64)}},expected:'STOP'},
    {name:'worktree Git base content SHA',next:'a',
      change:{taskBinding:{...trustedShape().taskBinding,
        baseSha256:'8'.repeat(64)}},expected:'STOP'},
    {name:'revoke-start during the prior step',next:'s',
      change:{ownerFence:{...trustedShape().ownerFence,
        revoking:true}},expected:'STOP'},
    {name:'revoked generation',next:'a',
      change:{ownerFence:{...trustedShape().ownerFence,
        revoked:true}},expected:'STOP'},
    {name:'unknown previous navigation effect',next:'a',
      change:{taskBinding:{...trustedShape().taskBinding,
        mutationState:'MUTATION_STATE_UNKNOWN'}},
      expected:'RECONCILE_REQUIRED'},
    {name:'UNKNOWN cloned Journal continuation',next:'s',
      change:{journal:{...trustedShape().journal,
        state:'MUTATION_STATE_UNKNOWN'}},expected:'RECONCILE_REQUIRED'},
  ] as const;
  let nextStepDispatches=0;
  for(const variant of scenarios){
    const current={...trustedShape(),...variant.change};
    const review=reviewBrowserMicroScenarioStepBoundary(
      plan,variant.next,current,
    );
    assert.equal(review.status,variant.expected,variant.name);
    assert.equal(review.canDispatch,false,variant.name);
    assert.equal(review.canReplay,false,variant.name);
    assert.equal(review.canAdvance,false,variant.name);
    assert.equal(review.requestId,plan.requestId,variant.name);
    assert.equal(review.logicalMutationId,plan.logicalMutationId,variant.name);
    // No new navigate/assert/screenshot call may be issued. Intentionally
    // no BrowserRuntime, CDP socket or native process is instantiated.
    if(review.canDispatch)nextStepDispatches++;
  }
  assert.equal(nextStepDispatches,0);
});
