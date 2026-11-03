import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explainHypervElevation,
  validHypervVmId,
  type HypervElevationSnapshot,
  type HypervDenialSource,
} from '../src/protocol/hyperv-elevation-evidence.js';

const DEVICE = 'isolated-qa02-host';
const VM_ID = '3a4b5c6d-7e8f-4091-a2b3-4c5d6e7f8090';
const OTHER_ID = '0d843c45-9999-4baf-9f22-511a16442299';
type Snapshot = HypervElevationSnapshot;

function facts(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    capability: 'hyperv.vm.start',
    deviceId: DEVICE,
    vmName: 'Synthetic HyperV Lab',
    vmId: VM_ID,
    agentConnected: true,
    currentProcessElevated: false,
    processIntegrity: 'medium',
    broker: {
      authenticatedHealth: 'unverified',
      elevatedToken: 'unverified',
      versionMatch: 'unverified',
      capabilityAllowed: false,
    },
    localApproval: 'verified',
    ownerPolicyApproved: true,
    ownerGrant: 'root',
    rootLease: 'verified',
    coreEnrollment: 'unverified',
    dispatch: 'not_sent',
    ...overrides,
  };
}

function rejectSuccess(snapshot: Snapshot, expected: HypervDenialSource, status:'denied'|'pending'|'unknown') {
  const r = explainHypervElevation(snapshot);
  assert.equal(r.execution.status,status);
  assert.equal(r.execution.denialSource,expected);
  assert.equal(r.execution.effectVerified,false);
  assert.equal(r.execution.automaticallyRetryable,false);
  assert.notEqual(r.execution.status,'succeeded');
  return r;
}

test('617 QA02 denialSource=windows: Medium integrity and deny-only Administrators never authorize Hyper-V', () => {
  const r=rejectSuccess(facts(),'windows','denied');
  assert.equal(r.execution.code,'HYPERV_ELEVATED_TOKEN_UNAVAILABLE');
  assert.equal(r.windows.currentProcessElevated,false);
  assert.equal(r.windows.processIntegrity,'medium');
  assert.equal(r.adminBridge.authenticatedHealth,'unverified');
});

test('617 QA02 denialSource=nexowire: disconnected Agent and unverified Broker are different failures', () => {
  const offline=rejectSuccess(facts({agentConnected:false}),'nexowire','denied');
  assert.equal(offline.execution.code,'AGENT_DISCONNECTED');
  const brokerOnly=rejectSuccess(facts({
    currentProcessElevated:null,processIntegrity:'unverified',
  }),'nexowire','denied');
  assert.equal(brokerOnly.execution.code,'HYPERV_BROKER_NOT_ATTESTED');
  const versionMismatch=rejectSuccess(facts({
    currentProcessElevated:true,processIntegrity:'high',
    broker:{authenticatedHealth:'verified',elevatedToken:'verified',
      versionMatch:'failed',capabilityAllowed:true},
  }),'nexowire','denied');
  assert.equal(versionMismatch.execution.code,'HYPERV_BROKER_NOT_ATTESTED');
});

test('617 QA02 denialSource=policy: scoped owner permission and immutable VMId are mandatory', () => {
  const owner=rejectSuccess(facts({ownerPolicyApproved:false}),'policy','denied');
  assert.equal(owner.execution.code,'HYPERV_OWNER_POLICY_UNVERIFIED');
  const missingGuid=rejectSuccess(facts({vmId:null}),'policy','denied');
  assert.equal(missingGuid.execution.code,'HYPERV_SCOPED_VM_ID_REQUIRED');
  assert.equal(validHypervVmId(VM_ID),true);
  for (const vmId of [null,'*','ReVoltVPN-Ubuntu-Lab','111','{'+VM_ID+'}']) {
    assert.equal(validHypervVmId(vmId),false);
  }
});

test('617 QA02 denialSource=user: an explicit refusal differs from a pending consent', () => {
  const denied=rejectSuccess(facts({localApproval:'rejected'}),'user','denied');
  assert.equal(denied.execution.code,'HYPERV_LOCAL_APPROVAL_REJECTED');
  const preapproved=rejectSuccess(facts({localApproval:'not_verified'}),'windows','denied');
  assert.equal(preapproved.execution.code,'HYPERV_ELEVATED_TOKEN_UNAVAILABLE');
  assert.equal(preapproved.delegation.perOperationUacRequired,false,
    'verified ROOT delegation must not require another UAC prompt');
});

test('617 QA02 denialSource=undetermined: lost UAC/RunAs acknowledgement overrides prior denials', () => {
  const cases:Snapshot[]=[
    facts({dispatch:'lost_confirmation',agentConnected:false,ownerPolicyApproved:false,
      localApproval:'rejected',vmId:null}),
    facts({dispatch:'ack_unverified',currentProcessElevated:false,processIntegrity:'medium'}),
    facts({dispatch:'lost_confirmation',broker:{authenticatedHealth:'failed',
      elevatedToken:'failed',versionMatch:'failed',capabilityAllowed:false}}),
  ];
  for (const caseFacts of cases) {
    const r=rejectSuccess(caseFacts,'undetermined','unknown');
    assert.equal(r.execution.code,'MUTATION_STATE_UNKNOWN');
  }
});

test('617 QA02: consent.exe seen, untrusted UAC approved flag and a forged ACK are not approval or proof', () => {
  const forged = Object.assign(facts({dispatch:'lost_confirmation',localApproval:'not_verified'}),{
    consentExePresent:true, remoteApproved:true, uacWindowSeen:true,
    requestExitCode:0, transportOk:true,
  });
  const r=rejectSuccess(forged,'undetermined','unknown');
  assert.equal(r.localApproval,'not_verified');
  assert.equal(r.execution.code,'MUTATION_STATE_UNKNOWN');
  assert.equal(r.execution.effectVerified,false);
});

test('617 QA02 stale VM Running status or wrong host/VMId readback cannot prove startup', () => {
  const oldRunning=Object.assign(facts({dispatch:'ack_unverified'}), {
    vmReadback:{state:'Running',vmId:VM_ID,deviceId:DEVICE,
      observedAt:'2025-01-01T00:00:00.000Z',verified:true},
  });
  const foreignRunning=Object.assign(facts({dispatch:'ack_unverified'}), {
    vmReadback:{state:'Running',vmId:OTHER_ID,deviceId:'foreign-host',
      observedAt:'2026-10-21T15:00:00.000Z',verified:true},
  });
  for(const untrusted of [oldRunning,foreignRunning]){
    const r=rejectSuccess(untrusted,'undetermined','unknown');
    assert.equal(r.execution.effectVerified,false);
    assert.equal(r.execution.automaticallyRetryable,false);
  }
  // Even syntactically valid alternate VM GUID is not an authorized binding.
  // The #618 explanation is not an executor and does not accept postconditions.
  const noDispatch=rejectSuccess(facts({
    vmId:OTHER_ID,currentProcessElevated:true,processIntegrity:'high',
    broker:{authenticatedHealth:'verified',elevatedToken:'verified',
      versionMatch:'verified',capabilityAllowed:true},
  }),'undetermined','pending');
  assert.equal(noDispatch.execution.code,'HYPERV_INDEPENDENT_EXECUTION_AND_READBACK_REQUIRED');
});

test('617 QA02: full local approval and authenticated Broker still cannot certify a VM transition', () => {
  const allGates=rejectSuccess(facts({
    currentProcessElevated:true,processIntegrity:'high',
    broker:{authenticatedHealth:'verified',elevatedToken:'verified',
      versionMatch:'verified',capabilityAllowed:true},
  }),'undetermined','pending');
  assert.equal(allGates.execution.code,'HYPERV_INDEPENDENT_EXECUTION_AND_READBACK_REQUIRED');
  const status=explainHypervElevation(facts({capability:'hyperv.vm.status',vmId:null}));
  assert.equal(status.windows.elevationRequired,'unverified');
  assert.equal(status.execution.effectVerified,false);
  assert.equal(status.execution.automaticallyRetryable,false);
});
