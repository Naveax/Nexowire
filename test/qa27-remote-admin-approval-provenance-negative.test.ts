import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWindowsUacStatus} from '../src/agent/windows-uac-status.js';
import {explainDeviceAuthorization, type DeviceAuthorizationFacts} from '../src/security/authorization-explain.js';
import {capabilitiesForPlatform, isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {
  assessHumanPromptPath,
  assessBrokerDelegationCandidate,
  type RemotePromptFixture,
  type EnrollmentProvenanceFixture,
  type CommandDelegationFixture,
} from './fixtures/qa27-remote-admin-provenance-oracle.js';

const NOW_MS = Date.parse('2026-10-21T15:00:00.000Z');
const SHA = 'a'.repeat(64);
const expectedPublisherId = 'synthetic-verified-vendor-id';

const remotelyAuthorized: RemotePromptFixture = {
  session: 'windows-remote-assistance',
  kind: 'standard-user-credentials',
  ownerAuthorizedRemoteHelp: true,
  authenticatedRemoteAdmin: true,
  uiAccessSigned: true,
  uiAccessProtectedLocation: true,
  uiAccessPolicyEnabled: true,
  physicalConsoleGrant: false,
  promptObservation: 'visible',
  consentCount: 1,
};
const syntheticReceipt: EnrollmentProvenanceFixture = {
  origin: 'trusted-native-enrollment-record',
  ownerId: 'owner-27',
  deviceId: 'device-27',
  enrollmentSessionId: 'local-enrollment-session-27',
  enrollmentRequestId: 'request-27',
  enrollmentNonce: 'nonce-27',
  publisherId: expectedPublisherId,
  executableSha256: SHA,
  signedImageAndImportsTrusted: true,
  parentAndUpdaterAclProtected: true,
  effectiveHighTokenAttested: true,
  installerCompleted: true,
  duplicateReceipt: false,
  receivedAtMs: NOW_MS - 10_000,
};
const syntheticCommand: CommandDelegationFixture = {
  ownerId: 'owner-27',
  deviceId: 'device-27',
  sessionId: 'new-owner-session-after-enrollment',
  ownerGrantEpoch: 12,
  installedGrantEpoch: 12,
  coreActive: true,
  revoked: false,
  commandPreapproved: true,
  brokerVersionMatches: true,
  expectedPublisherId,
  expectedExecutableSha256: SHA,
  nowMs: NOW_MS,
};

function currentAuthorization(overrides: Partial<DeviceAuthorizationFacts> = {}) {
  return explainDeviceAuthorization({
    deviceId: syntheticCommand.deviceId,
    ownerAccountId: syntheticCommand.ownerId,
    requesterAccountId: syntheticCommand.ownerId,
    requesterRole: 'user',
    accessMode: 'full',
    online: true,
    privilegeMode: 'broker',
    adminBridgeReady: true,
    rootLease: null,
    corePreference: {
      ownerAccountId: syntheticCommand.ownerId, enabled: true,
      updatedAt: new Date(NOW_MS).toISOString(),
    },
    bridgePreference: {
      ownerAccountId: syntheticCommand.ownerId, desiredMode: 'on',
      updatedAt: new Date(NOW_MS).toISOString(),
    },
    now: new Date(NOW_MS),
    ...overrides,
  }, 'windows.task.control');
}

test('owner-approved Remote Assistance UIAccess supports only conditional human credential entry, not UAC auto-approval', async () => {
  const humanPath = assessHumanPromptPath(remotelyAuthorized);
  assert.equal(humanPath.humanPromptRoute, 'conditional-remote-assistance');
  assert.equal(humanPath.reason, 'HUMAN_REMOTE_ADMIN_CREDENTIALS_REQUIRED');
  assert.equal(humanPath.needsActualOsConsent, true);
  assert.equal(humanPath.uacApproved, false);
  assert.equal(remotelyAuthorized.physicalConsoleGrant, false);

  const observed = await inspectWindowsUacStatus({
    platform: 'win32', accessMode: 'full',
    consentCount: async () => remotelyAuthorized.consentCount!,
  });
  assert.equal(observed.observation, 'pending');
  assert.equal(observed.autoClickConsentSupported, false);
  assert.equal(currentAuthorization().windows.uacApproval, 'unverified');
  assert.equal(currentAuthorization().windows.physicalConsoleApproval, 'unverified');
  assert.equal(currentAuthorization().operation.elevatedExecutionProven, false);
});

test('negative UIAccess matrix: fake remote approval, unsigned/unprotected helper, disabled policy and administrator prompts', async t => {
  const cases: ReadonlyArray<{name: string; override: Partial<RemotePromptFixture>}> = [
    {name:'unapproved-assistance', override:{ownerAuthorizedRemoteHelp:false}},
    {name:'unauthenticated-remote-admin', override:{authenticatedRemoteAdmin:false}},
    {name:'forged-uiaccess-signature', override:{uiAccessSigned:false}},
    {name:'user-writable-uiaccess-image', override:{uiAccessProtectedLocation:false}},
    {name:'default-disabled-uiaccess-policy', override:{uiAccessPolicyEnabled:false}},
    {name:'generic-remote-desktop', override:{session:'rdp'}},
    {name:'browser-remote-control', override:{session:'browser'}},
    {name:'headless-remote-control', override:{session:'headless'}},
    {name:'administrator-consent-unchanged-by-uiaccess', override:{kind:'administrator-consent'}},
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const answer = assessHumanPromptPath({...remotelyAuthorized, ...item.override});
      assert.equal(answer.humanPromptRoute, 'unavailable');
      assert.equal(answer.uacApproved, false);
      assert.equal(answer.needsActualOsConsent, true);
    });
  }
});

test('forged consent.exe process count, screenshot and session telemetry cannot mint approval or execute a privileged action', async () => {
  let privilegedDispatches = 0;
  // Broker execute spy is purposefully not wired into the observer.
  const fakeBroker = {
    probe: async () => ({reachable:true, elevated:true, version:'1.0.5'}),
    execute: async () => {privilegedDispatches++; throw Error('Unexpected privileged dispatch');},
  };
  const reported = await inspectWindowsUacStatus({
    platform:'win32', accessMode:'full', broker:fakeBroker,
    consentCount: async () => 9999,
  });
  assert.equal(reported.observation, 'pending');
  assert.equal(reported.autoClickConsentSupported, false);
  assert.equal(reported.recommendedAction, 'use_preapproved_installer_broker');
  assert.equal(privilegedDispatches, 0);
  assert.equal(currentAuthorization().adminBridge.authenticatedBrokerHealth, 'unverified');
  assert.equal(currentAuthorization().operation.decision, 'not-proven');
  assert.equal(currentAuthorization().operation.elevatedExecutionProven, false);

  for (const origin of ['consent-exe-count','screenshot','agent-telemetry','remote-helper-claim'] as const) {
    const receipt = {...syntheticReceipt, origin};
    const decision = assessBrokerDelegationCandidate(receipt, syntheticCommand, () => true);
    assert.equal(decision.state, 'UNVERIFIED', origin);
    assert.equal(decision.reason, 'UNTRUSTED_ORIGIN');
    assert.equal(decision.uacApprovedByThisCheck, false);
  }
});

test('forbidden Secure Desktop or missing console grant never becomes local UAC approval', async () => {
  const protectedDesktop = await inspectWindowsUacStatus({
    platform:'win32', accessMode:'full',
    consentCount: async () => {throw Error('Synthetic FORBIDDEN secure desktop');},
    broker:{probe:async()=>({reachable:true,elevated:true,version:'1.0.5'})},
  });
  assert.equal(protectedDesktop.observation, 'unknown');
  assert.equal(protectedDesktop.consentProcessCount, null);
  assert.equal(protectedDesktop.recommendedAction, 'investigate_process_visibility');
  assert.equal(protectedDesktop.autoClickConsentSupported, false);
  const consoleDenied = assessHumanPromptPath({
    ...remotelyAuthorized,
    session:'local-console',
    physicalConsoleGrant:false,
    promptObservation:'secure-desktop-forbidden',
  });
  assert.equal(consoleDenied.reason, 'NO_PHYSICAL_CONSOLE_GRANT');
  assert.equal(consoleDenied.humanPromptRoute, 'unavailable');
  assert.equal(consoleDenied.uacApproved, false);
  const onlyAppearanceChanged = assessHumanPromptPath({
    ...remotelyAuthorized, promptObservation:'secure-desktop-forbidden', consentCount:null,
  });
  // A legitimate assisted-session request may still require manual credentials.
  // Inability to observe a secure desktop NEVER proves approval.
  assert.equal(onlyAppearanceChanged.uacApproved, false);
  assert.equal(onlyAppearanceChanged.needsActualOsConsent, true);
  assert.equal(currentAuthorization().windows.physicalConsoleApproval, 'unverified');
});

test('source-only signed Broker model: one enrolled Broker can be candidate for later CORE without per-command UAC, not verified production', () => {
  let independentVerificationCalls = 0;
  const separatelyVerifiedFixture = () => {independentVerificationCalls++; return true;};
  const candidate = assessBrokerDelegationCandidate(
    syntheticReceipt, syntheticCommand, separatelyVerifiedFixture,
  );
  assert.equal(independentVerificationCalls, 1);
  assert.equal(candidate.state, 'CONTRACT_CANDIDATE');
  assert.equal(candidate.reason, 'PHYSICAL_EVIDENCE_STILL_REQUIRED');
  assert.equal(candidate.needsPerCommandUac, false);
  assert.equal(candidate.uacApprovedByThisCheck, false);
  assert.equal(candidate.actualCommandExecuted, false);
  const production = currentAuthorization();
  assert.equal(production.core.state, 'PAUSED_UNVERIFIED');
  assert.equal(production.windows.adminToken, 'unverified');
  assert.equal(production.windows.uacApproval, 'unverified');
  assert.equal(production.operation.elevatedExecutionProven, false);
  assert.equal(production.operation.providerAuthorizationProven, false);

  const rejected = assessBrokerDelegationCandidate(syntheticReceipt, syntheticCommand, () => false);
  assert.equal(rejected.reason, 'INDEPENDENT_OS_VERIFICATION_REQUIRED');
  assert.equal(rejected.state, 'UNVERIFIED');
  assert.equal(rejected.needsPerCommandUac, false);
});

test('negative Broker provenance matrix rejects forged installation, stale owner/revoke, mismatched publisher and missing physical attestation', async t => {
  const cases: ReadonlyArray<{
    name:string; enrollment?: Partial<EnrollmentProvenanceFixture>;
    command?:Partial<CommandDelegationFixture>; verified?:boolean;
    expected:string;
  }> = [
    {name:'fake-broker-health-only',enrollment:{origin:'agent-telemetry'},expected:'UNTRUSTED_ORIGIN'},
    {name:'wrong-owner',enrollment:{ownerId:'foreign-owner'},expected:'PROVENANCE_IDENTITY_MISMATCH'},
    {name:'wrong-device',enrollment:{deviceId:'foreign-device'},expected:'PROVENANCE_IDENTITY_MISMATCH'},
    {name:'missing-os-request-id',enrollment:{enrollmentRequestId:''},expected:'PROVENANCE_IDENTITY_MISMATCH'},
    {name:'missing-replay-nonce',enrollment:{enrollmentNonce:''},expected:'PROVENANCE_IDENTITY_MISMATCH'},
    {name:'unexpected-publisher',enrollment:{publisherId:'forged-publisher'},expected:'SIGNED_PROTECTED_IMAGE_UNPROVEN'},
    {name:'wrong-executable-hash',enrollment:{executableSha256:'b'.repeat(64)},expected:'SIGNED_PROTECTED_IMAGE_UNPROVEN'},
    {name:'untrusted-imports',enrollment:{signedImageAndImportsTrusted:false},expected:'SIGNED_PROTECTED_IMAGE_UNPROVEN'},
    {name:'writable-parent-or-updater',enrollment:{parentAndUpdaterAclProtected:false},expected:'SIGNED_PROTECTED_IMAGE_UNPROVEN'},
    {name:'installer-no-completion-proof',enrollment:{installerCompleted:false},expected:'INSTALL_OR_HIGH_TOKEN_UNPROVEN'},
    {name:'no-effective-high-token',enrollment:{effectiveHighTokenAttested:false},expected:'INSTALL_OR_HIGH_TOKEN_UNPROVEN'},
    {name:'duplicate-approval-ack',enrollment:{duplicateReceipt:true},expected:'DUPLICATE_ENROLLMENT_RECEIPT'},
    {name:'stale-enrollment-receipt',enrollment:{receivedAtMs:NOW_MS-31*24*60*60*1000},expected:'ENROLLMENT_PROVENANCE_STALE_OR_INVALID'},
    {name:'future-dated-enrollment-receipt',enrollment:{receivedAtMs:NOW_MS+1},expected:'ENROLLMENT_PROVENANCE_STALE_OR_INVALID'},
    {name:'independent-verifier-unavailable',verified:false,expected:'INDEPENDENT_OS_VERIFICATION_REQUIRED'},
    {name:'old-grant-epoch',command:{ownerGrantEpoch:11},expected:'CURRENT_OWNER_GRANT_DENIED'},
    {name:'revoked-owner-grant',command:{revoked:true},expected:'CURRENT_OWNER_GRANT_DENIED'},
    {name:'CORE-off',command:{coreActive:false},expected:'CURRENT_OWNER_GRANT_DENIED'},
    {name:'command-not-preapproved',command:{commandPreapproved:false},expected:'CURRENT_OWNER_GRANT_DENIED'},
    {name:'session-missing',command:{sessionId:''},expected:'CURRENT_OWNER_GRANT_DENIED'},
    {name:'broker-version-mismatch',command:{brokerVersionMatches:false},expected:'BROKER_VERSION_MISMATCH'},
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const res = assessBrokerDelegationCandidate(
        {...syntheticReceipt,...item.enrollment},
        {...syntheticCommand,...item.command},
        () => item.verified ?? true,
      );
      assert.equal(res.state, 'UNVERIFIED');
      assert.equal(res.reason, item.expected);
      assert.equal(res.needsPerCommandUac, false);
      assert.equal(res.uacApprovedByThisCheck, false);
      assert.equal(res.actualCommandExecuted, false);
    });
  }
});

test('UAC observation is a read-only Windows capability; there is no synthetic approve/click/bypass capability', () => {
  const caps = capabilitiesForPlatform('win32');
  assert.ok(caps.includes('windows.uac.status'));
  assert.equal(isReadOnlyCapability('windows.uac.status'), true);
  for (const bogus of [
    'windows.uac.approve', 'windows.remote_assistance.approve', 'windows.uac.silent_click',
    'windows.secure_desktop.switch', 'windows.uac.policy.disable',
  ]) assert.ok(!caps.includes(bogus), bogus);
});
