/**
 * QA #27 / P0 #617 / NEXT4:
 * Distinct native Broker /execute admission negative. This exercises the REAL
 * #03 HTTP dispatcher with a disposable, non-elevated, loopback-only test
 * instance whose injected executor is an INERT in-memory counter.
 *
 * NEVER contacts the user's installed Broker, real Agent, Secure Desktop,
 * Windows service, ACL, Cloudflare, VM or other external state.
 * requireElevation:false is test-only, NOT a model of signed HIGH approval.
 * Expected RED: a bearer + elevated capability currently reaches callback
 * without ROOT cutoff, current owner generation, local OS enrollment or
 * independently atomic external final native-effect dispatch authority.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {startPrivilegedBroker} from '../../src/agent/privileged-broker.js';
import {PrivilegedBrokerClient} from '../../src/agent/privileged-broker-client.js';
import {privilegeRequirement} from '../../src/security/privilege.js';
import {
  explainDeviceAuthorization,type DeviceAuthorizationFacts,
} from '../../src/security/authorization-explain.js';
import {
  classifySourceOnlyCrossBranchCase,syntheticCrossBranchCase,
} from '../fixtures/qa27-core-broker-external-authority-contract.js';

const started=Date.parse('2026-10-23T01:00:00.000Z');
const cutoff=started+900_000;
const token='qa27-disposable-native-boundary-not-installed';
const capability='windows.service.control' as const;
const input={action:'start',service:'QA27_INERT_NO_REAL_OS_SERVICE'};

type Case='root-open-no-final-proof'|'root-expired'|'owner-generation-revoked'|'core-preference-only';

function sourceExpectation(which:Case):void{
  const at=which==='root-expired'?cutoff:cutoff-1;
  const root=which.startsWith('root');
  const facts:DeviceAuthorizationFacts={
    deviceId:'qa27-device',ownerAccountId:'qa27-owner',
    requesterAccountId:'qa27-owner',requesterRole:'user',
    accessMode:'full',online:true,privilegeMode:'broker',
    adminBridgeReady:true,
    rootLease:root?{
      ownerAccountId:'qa27-owner',expiresAt:new Date(cutoff).toISOString(),
    }:null,
    corePreference:{
      ownerAccountId:'qa27-owner',enabled:true,
      updatedAt:new Date(started).toISOString(),
    },
    bridgePreference:{
      ownerAccountId:'qa27-owner',desiredMode:'on',
      updatedAt:new Date(started).toISOString(),
    },
    now:new Date(at),
  };
  const projection=explainDeviceAuthorization(facts,capability);
  assert.equal(projection.root.leaseUnexpired,
    root && which==='root-open-no-final-proof');
  assert.equal(projection.operation.privilegeRequirement,'elevated');
  assert.equal(projection.operation.elevatedExecutionProven,false);
  assert.equal(projection.operation.providerAuthorizationProven,false);
  assert.equal(projection.core.state,'PAUSED_UNVERIFIED');
  if(which==='root-expired'){
    assert.ok(projection.operation.reasons.includes(
      'ROOT_LEASE_EXPIRED_OR_REVOKED'));
  }
  if(which==='owner-generation-revoked'){
    const f=syntheticCrossBranchCase;
    const result=classifySourceOnlyCrossBranchCase({
      ...f,
      authority:{...f.authority,ownerEpoch:f.authority.ownerEpoch+1,revoked:true},
      remote:{...f.remote,remoteRevokeGenerationCurrent:false},
    });
    assert.equal(result.result,'BLOCKED');
    assert.equal(result.reason,'OWNER_SESSION_OR_EPOCH_REVOKED');
    assert.equal(result.canExecutePrivilegedCommand,false);
  }
  if(which==='core-preference-only'){
    const f=syntheticCrossBranchCase;
    const result=classifySourceOnlyCrossBranchCase({
      ...f,
      enrollment:{...f.enrollment,
        independentOsResultVerified:false,localOsHumanApprovalRecorded:false},
    });
    assert.equal(result.result,'BLOCKED');
    assert.equal(result.reason,'OS_ENROLLMENT_NOT_AUTHENTICATED');
    assert.equal(result.canExecutePrivilegedCommand,false);
  }
}

test('QA27 real #03 Broker /execute denies absent native FINAL grant at ROOT cutoff, revoke and CORE preference',{
  skip:process.platform!=='win32',
},async t=>{
  // A Windows CI disposable HTTP fixture only. Explicitly no elevated OS
  // process and no actual native Windows effect, signed provider or CAS.
  let callbacks=0;
  const server=await startPrivilegedBroker({
    host:'127.0.0.1',port:0,tokens:[token],requireElevation:false,
    execute:async()=>{
      callbacks++;
      return {qaOnly:true,realNativeEffect:false};
    },
  });
  t.after(async()=>{await server.close();});
  const client=new PrivilegedBrokerClient({url:server.url,token});
  assert.equal(privilegeRequirement(capability,input),'elevated');

  const scenarios:readonly {name:string;which:Case}[]=[
    {name:'ROOT T+899999ms: no real installed HIGH/final CAS',
      which:'root-open-no-final-proof'},
    {name:'ROOT T+900000ms: expired before native admission',
      which:'root-expired'},
    {name:'owner generation revoked: earlier bearer never final authority',
      which:'owner-generation-revoked'},
    {name:'CORE preference-only: no protected OS enrollment',
      which:'core-preference-only'},
  ];
  for(const scenario of scenarios){
    await t.test(scenario.name,async()=>{
      sourceExpectation(scenario.which);
      const before=callbacks;
      let denied=false;
      try{
        await client.execute(capability,input);
      }catch{denied=true}
      // The #03 native HTTP endpoint has no trusted owner epoch/ROOT lease/
      // installed HIGH identity/final off-host atomic grant input to validate.
      // Consequently legacy source reaches inert callback: EXPECTED RED.
      assert.equal(callbacks,before,
        scenario.name+': Broker /execute called native-effect callback with '+
        'no independent HIGH/ROOT/CORE owner-generation/final CAS evidence');
      assert.equal(denied,true,
        scenario.name+': missing real external/native authority must DENY');
    });
  }
});
