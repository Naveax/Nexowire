import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  BrowserMicroNavigationObservationV1Schema,
  reviewBrowserMicroNavigationBoundary,
} from '../src/agent/browser-micro-scenario-navigation-boundary.js';

function fixture(){
  return {
    version:1 as const,taskId:'task-a',
    logicalMutationId:randomUUID(),requestId:randomUUID(),
    ownerId:randomUUID(),deviceId:randomUUID(),
    deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),
    ownerEpoch:3,grantGeneration:5,
    taskGrantId:randomUUID(),worktreeGrantId:randomUUID(),
    sandboxId:randomUUID(),worktreeBaseSha:'a'.repeat(40),
    worktreeDiffSha:'b'.repeat(64),semanticEffectSha256:'c'.repeat(64),
    worktreeIdentitySha256:'d'.repeat(64),
    preimageSha256:'e'.repeat(64),baseSha256:'f'.repeat(64),
    browserSessionId:randomUUID(),targetId:'page-1',
    allowedOrigin:'https://example.com',
    maxDurationMs:20_000,maxEvidenceBytes:250_000,
    journalState:'PLANNED' as const,
    steps:[
      {op:'navigate' as const,id:'n',url:'https://example.com/start',timeoutMs:5_000},
      {op:'wait' as const,id:'w',readyState:'complete' as const,timeoutMs:2_000},
      {op:'assert' as const,id:'a',selector:'#status',
        expectedText:'ready',textMode:'exact' as const},
      {op:'screenshot' as const,id:'s',maxBytes:130_000},
    ],
  };
}

test('#08 CDP lost ACK, redirect and emergency stop cannot advance or replay',()=>{
  const plan=fixture();
  const valid=()=>{
    return {
      version:1 as const,
      requestId:plan.requestId,logicalMutationId:plan.logicalMutationId,
      browserSessionId:plan.browserSessionId,targetId:plan.targetId,
      navigationStepId:'n',ackState:'ACK_VERIFIED' as const,
      finalUrl:'https://example.com/done',
      emergencyStop:'CLEAR_SOURCE_ONLY' as const,
    };
  };
  // A positive-shaped post-navigation source observation is NOT authority.
  const positive=reviewBrowserMicroNavigationBoundary(plan,valid());
  assert.equal(positive.status,'SOURCE_OBSERVATION_MATCHED_NO_AUTHORITY');
  assert.equal(positive.canDispatch,false);
  assert.equal(positive.canAdvance,false);
  assert.equal(positive.evidenceVerified,false);

  const scenarios=[
    {name:'Page.navigate response lost after possible native dispatch',
      input:{...valid(),ackState:'ACK_LOST_OR_UNKNOWN'},status:'RECONCILE_REQUIRED',
      reason:'NAVIGATION_ACK_UNKNOWN'},
    {name:'Journal says dispatch may have happened',
      input:{...valid(),ackState:'DISPATCH_MAY_HAVE_OCCURRED'},
      status:'RECONCILE_REQUIRED',reason:'NAVIGATION_ACK_UNKNOWN'},
    {name:'redirect to foreign final origin',
      input:{...valid(),finalUrl:'https://outside.test/redirect'},
      status:'STOP',reason:'FINAL_ORIGIN_MISMATCH'},
    {name:'ACK was received but final URL was never authenticated',
      input:{...valid(),finalUrl:undefined},
      status:'STOP',reason:'FINAL_ORIGIN_MISMATCH'},
    {name:'redirected to privileged local file',
      input:{...valid(),finalUrl:'file:///C:/secret.txt'},
      status:'STOP',reason:'FINAL_ORIGIN_MISMATCH'},
    {name:'different CDP target with same task',
      input:{...valid(),targetId:'foreign-target'},
      status:'STOP',reason:'TARGET_OR_REQUEST_CHANGED'},
    {name:'unknown local stop state preempts apparent successful status',
      input:{...valid(),emergencyStop:'UNKNOWN'},
      status:'STOP',reason:'EMERGENCY_STOP_OR_UNKNOWN'},
    {name:'requested emergency stop preempts apparent successful status',
      input:{...valid(),emergencyStop:'REQUESTED'},
      status:'STOP',reason:'EMERGENCY_STOP_OR_UNKNOWN'},
    {name:'the next assert step is not a navigate receipt',
      input:{...valid(),navigationStepId:'a'},
      status:'STOP',reason:'NOT_A_NAVIGATION_STEP'},
  ] as const;
  let dispatches=0;
  for(const scenario of scenarios){
    const result=reviewBrowserMicroNavigationBoundary(plan,scenario.input);
    assert.equal(result.status,scenario.status,scenario.name);
    assert.equal(result.reason,scenario.reason,scenario.name);
    assert.equal(result.requestId,plan.requestId,scenario.name);
    assert.equal(result.logicalMutationId,plan.logicalMutationId,scenario.name);
    assert.equal(result.canDispatch,false,scenario.name);
    assert.equal(result.canReplay,false,scenario.name);
    assert.equal(result.canAdvance,false,scenario.name);
    assert.equal(result.physicalStopVerified,false,scenario.name);
    if(result.canDispatch)dispatches++;
  }
  assert.equal(dispatches,0);
  assert.equal(BrowserMicroNavigationObservationV1Schema.safeParse(
    {...valid(),grantVerified:true},
  ).success,false,'RPC cannot add a fake grant');
});
