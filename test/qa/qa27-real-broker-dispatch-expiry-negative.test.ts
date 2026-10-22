/**
 * QA27 independent HOSTILE NEGATIVE against the REAL Agent capability ->
 * PrivilegedBrokerClient.execute admission path on #722.
 *
 * Do NOT mistake the inert injected Broker stub for an installed HIGH Windows
 * Broker or an external CAS provider. No network, OS command, UAC, VM or files
 * are mutated by this test. The legacy AgentExecutionContext exposes no
 * authenticated ROOT owner/session expiry, CORE enrollment, owner generation,
 * native HIGH witness or independent final CAS grant, so this is expected RED
 * until the proper #01/#03/#04 source-owner admission seam is integrated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {executeCapability,type AgentExecutionContext}
  from '../../src/agent/executors.js';
import {PathPolicy} from '../../src/agent/path-policy.js';
import {
  explainDeviceAuthorization,type DeviceAuthorizationFacts,
} from '../../src/security/authorization-explain.js';
import {
  classifySourceOnlyCrossBranchCase,syntheticCrossBranchCase,
} from '../fixtures/qa27-core-broker-external-authority-contract.js';

const issuedAt=Date.parse('2026-10-23T00:00:00.000Z');
const endAt=issuedAt+900_000;
const rootLease={ownerAccountId:'qa27-owner',
  expiresAt:new Date(endAt).toISOString()};
const stamp=new Date(issuedAt).toISOString();

function explainAt(nowMs:number, root:boolean, corePreference:boolean){
  const facts:DeviceAuthorizationFacts={
    deviceId:'qa27-device',ownerAccountId:'qa27-owner',
    requesterAccountId:'qa27-owner',requesterRole:'user',
    accessMode:'full',online:true,privilegeMode:'broker',
    adminBridgeReady:true,
    rootLease:root?rootLease:null,
    corePreference:corePreference?{
      ownerAccountId:'qa27-owner',enabled:true,updatedAt:stamp,
    }:null,
    bridgePreference:{
      ownerAccountId:'qa27-owner',desiredMode:'on',updatedAt:stamp,
    },
    now:new Date(nowMs),
  };
  return explainDeviceAuthorization(facts,'windows.service.control');
}

test('QA27 real elevated broker dispatch must stop for ROOT cutoff, revoked generation and pref-only CORE',async t=>{
  const cases=[
    {label:'ROOT T+899999ms: time still open but absent native/CAS admission',
      now:endAt-1,root:true,pref:false,active:true,
      precondition:'native-unverified'},
    {label:'ROOT exactly T+900000ms: expiry before effect',
      now:endAt,root:true,pref:false,active:false,
      precondition:'expired-root'},
    {label:'owner generation revoked: old signed-permit snapshot cannot dispatch',
      now:endAt-1,root:true,pref:false,active:true,
      precondition:'revoked-generation'},
    {label:'CORE preference-only, no independently authenticated local enrollment',
      now:endAt-1,root:false,pref:true,active:false,
      precondition:'preference-only-core'},
  ] as const;
  for(const c of cases){
    await t.test(c.label,async()=>{
      const projection=explainAt(c.now,c.root,c.pref);
      assert.equal(projection.root.leaseUnexpired,c.active);
      assert.equal(projection.operation.privilegeRequirement,'elevated');
      assert.equal(projection.operation.elevatedExecutionProven,false);
      assert.equal(projection.operation.providerAuthorizationProven,false);
      assert.equal(projection.operation.decision,'not-proven');
      assert.equal(projection.windows.adminToken,'unverified');
      if(c.precondition==='expired-root'){
        assert.ok(projection.operation.reasons.includes(
          'ROOT_LEASE_EXPIRED_OR_REVOKED'));
      }
      if(c.precondition==='preference-only-core'){
        assert.equal(projection.core.enabled,true);
        assert.equal(projection.core.state,'PAUSED_UNVERIFIED');
        const candidate={
          ...syntheticCrossBranchCase,
          enrollment:{
            ...syntheticCrossBranchCase.enrollment,
            independentOsResultVerified:false,
            localOsHumanApprovalRecorded:false,
          },
        };
        const decision=classifySourceOnlyCrossBranchCase(candidate);
        assert.equal(decision.result,'BLOCKED');
        assert.equal(decision.reason,'OS_ENROLLMENT_NOT_AUTHENTICATED');
      }
      if(c.precondition==='revoked-generation'){
        const candidate={
          ...syntheticCrossBranchCase,
          authority:{
            ...syntheticCrossBranchCase.authority,
            installedOwnerEpoch:syntheticCrossBranchCase.authority.ownerEpoch+1,
            revoked:true,
          },
          remote:{
            ...syntheticCrossBranchCase.remote,
            remoteRevokeGenerationCurrent:false,
          },
        };
        const decision=classifySourceOnlyCrossBranchCase(candidate);
        assert.equal(decision.result,'BLOCKED');
        assert.equal(decision.reason,'OWNER_SESSION_OR_EPOCH_REVOKED');
      }

      // The actual executeCapability(...) API presently accepts only
      // accessMode and privilegeMode to select the Broker branch. This
      // intentionally provides ZERO trustworthy native/effect witnesses.
      // A real admission gate must DENY before calling execute(), at both
      // sides of the ROOT cutoff and after any revoke/re-pair.
      let inertBrokerCalls=0;
      const noOsBroker={
        execute:async(_capability:string,_input:unknown)=>{
          inertBrokerCalls++;
          return {qaOnly:true,noNativeExecution:true};
        },
      } as unknown as NonNullable<AgentExecutionContext['privilegedBroker']>;
      const context:AgentExecutionContext={
        accessMode:'full',privilegeMode:'broker',privilegedBroker:noOsBroker,
      };
      let deniedBeforeBroker=false;
      try{
        await executeCapability(
          'windows.service.control',
          {action:'start',service:'QA27_INERT_TEST_NO_OS_SERVICE'},
          new PathPolicy([]),
          context,
        );
      }catch{deniedBeforeBroker=true}
      assert.equal(inertBrokerCalls,0,
        c.label+': real Agent dispatcher reached an inert Broker without '+
        'authenticated native HIGH/ROOT/CORE owner-generation/final CAS grant');
      assert.equal(deniedBeforeBroker,true,
        c.label+': absent external native dispatch authority must DENY');
    });
  }
});
