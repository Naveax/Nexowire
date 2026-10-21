import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectWindowsUacStatus } from '../src/agent/windows-uac-status.js';
import { explainDeviceAuthorization, type DeviceAuthorizationFacts } from '../src/security/authorization-explain.js';
import { capabilitiesForPlatform, isReadOnlyCapability } from '../src/protocol/capabilities.js';
import {
  assessHumanPromptPath,
  assessBrokerDelegationCandidate,
  type EnrollmentProvenanceFixture,
  type CommandDelegationFixture,
} from './fixtures/qa27-remote-admin-provenance-oracle.js';
import {
  assessNativeApprovalOutcome,
  syntheticApprovalContext as context,
  syntheticNativeWitness as witness,
  type AssistedApprovalContext,
  type NativeLaunchWitness,
  type ApprovalContractReason,
} from './fixtures/qa27-native-windows-approval-witness.js';

/** No real OS calls: all UAC process and Broker probes below are injected. */
function productionExplanation(): ReturnType<typeof explainDeviceAuthorization> {
  const facts: DeviceAuthorizationFacts = {
    deviceId: context.deviceId,
    ownerAccountId: context.ownerId,
    requesterAccountId: context.ownerId,
    requesterRole: 'user',
    accessMode: 'full',
    online: true,
    privilegeMode: 'broker',
    adminBridgeReady: true,
    rootLease: null,
    corePreference: {
      ownerAccountId: context.ownerId, enabled: true,
      updatedAt: new Date(context.nowMs).toISOString(),
    },
    bridgePreference: {
      ownerAccountId: context.ownerId, desiredMode: 'on',
      updatedAt: new Date(context.nowMs).toISOString(),
    },
    now: new Date(context.nowMs),
  };
  return explainDeviceAuthorization(facts, 'windows.task.control');
}

test('approved Remote Assistance session is human credential eligibility, not an OS UAC approval result', async () => {
  const conditional = assessHumanPromptPath({
    session: 'windows-remote-assistance', kind: 'standard-user-credentials',
    ownerAuthorizedRemoteHelp: true, authenticatedRemoteAdmin: true,
    uiAccessSigned: true, uiAccessProtectedLocation: true,
    uiAccessPolicyEnabled: true, physicalConsoleGrant: false,
    promptObservation: 'visible', consentCount: 1,
  });
  assert.equal(conditional.humanPromptRoute, 'conditional-remote-assistance');
  assert.equal(conditional.uacApproved, false);

  let trustedProviderChecks = 0;
  const simulatedWindowsApprovedLaunch = assessNativeApprovalOutcome(context, witness, () => {
    trustedProviderChecks++;
    return true; // Synthetic external evidence verifier, NOT a Windows-native verification.
  });
  assert.equal(trustedProviderChecks, 1);
  assert.equal(simulatedWindowsApprovedLaunch.assistedRoute, 'eligible-remote-credentials');
  assert.equal(simulatedWindowsApprovedLaunch.result, 'CONTRACT_CANDIDATE');
  assert.equal(simulatedWindowsApprovedLaunch.realWindowsUacApproved, false);
  assert.equal(simulatedWindowsApprovedLaunch.actualElevatedExecutionProven, false);
  assert.equal(simulatedWindowsApprovedLaunch.issuedCommand, false);
  assert.equal(context.physicalOwnerPresent, false);
  assert.equal(context.physicalConsoleGrant, false);

  const production = productionExplanation();
  assert.equal(production.windows.uacApproval, 'unverified');
  assert.equal(production.windows.adminToken, 'unverified');
  assert.equal(production.windows.physicalConsoleApproval, 'unverified');
  assert.equal(production.operation.elevatedExecutionProven, false);
  assert.equal(production.operation.decision, 'not-proven');
});

test('Windows approval witness matrix: no forged consent.exe, wrong session, absent owner or fallback may become a valid OS outcome', async t => {
  const negatives: ReadonlyArray<{
    name: string;
    ctx?: Partial<AssistedApprovalContext>;
    w?: Partial<NativeLaunchWitness>;
    noWitness?: boolean;
    nativeVerifierResult?: boolean;
    expectedResult: 'UNVERIFIED' | 'DENIED' | 'UNKNOWN';
    expectedReason: ApprovalContractReason;
  }> = [
    { name: 'owner-absent-assistance-not-authorized', ctx: {ownerApprovedAssistance:false},
      expectedResult:'UNVERIFIED', expectedReason:'HUMAN_INTERACTION_NOT_ESTABLISHED' },
    { name: 'owner-absent-no-session-authorization', ctx: {remoteAdminAuthenticated:false},
      expectedResult:'UNVERIFIED', expectedReason:'HUMAN_INTERACTION_NOT_ESTABLISHED' },
    { name: 'unsigned-uiaccess-helper', ctx: {uiAccessSignatureVerified:false},
      expectedResult:'UNVERIFIED', expectedReason:'HUMAN_INTERACTION_NOT_ESTABLISHED' },
    { name: 'writable-uiaccess-install', ctx: {uiAccessInstallProtected:false},
      expectedResult:'UNVERIFIED', expectedReason:'HUMAN_INTERACTION_NOT_ESTABLISHED' },
    { name: 'disabled-uiaccess-policy', ctx: {uiAccessPolicyEnabled:false},
      expectedResult:'UNVERIFIED', expectedReason:'HUMAN_INTERACTION_NOT_ESTABLISHED' },
    { name: 'admin-consent-prompt-not-covered-by-policy', ctx: {promptClass:'admin-consent'},
      expectedResult:'UNVERIFIED', expectedReason:'HUMAN_INTERACTION_NOT_ESTABLISHED' },
    { name: 'browser-is-not-windows-remote-assistance', ctx: {surface:'browser'},
      expectedResult:'UNVERIFIED', expectedReason:'HUMAN_INTERACTION_NOT_ESTABLISHED' },
    { name: 'headless-is-not-windows-remote-assistance', ctx: {surface:'headless'},
      expectedResult:'UNVERIFIED', expectedReason:'HUMAN_INTERACTION_NOT_ESTABLISHED' },
    { name: 'generic-rdp-is-not-windows-remote-assistance', ctx: {surface:'rdp'},
      expectedResult:'UNVERIFIED', expectedReason:'HUMAN_INTERACTION_NOT_ESTABLISHED' },
    { name: 'local-console-no-physical-grant', ctx: {surface:'local-console',physicalOwnerPresent:false,physicalConsoleGrant:false},
      expectedResult:'UNVERIFIED', expectedReason:'HUMAN_INTERACTION_NOT_ESTABLISHED' },
    { name: 'remote-help-eligible-but-no-native-approval', noWitness:true,
      expectedResult:'UNVERIFIED', expectedReason:'NATIVE_EVIDENCE_MISSING' },
    { name: 'consent-exe-count-forged-as-native-result', w: {origin:'consent.exe'},
      expectedResult:'UNVERIFIED', expectedReason:'UNTRUSTED_EVIDENCE_ORIGIN' },
    { name: 'remote-screenshot-forged-as-native-result', w: {origin:'screenshot'},
      expectedResult:'UNVERIFIED', expectedReason:'UNTRUSTED_EVIDENCE_ORIGIN' },
    { name: 'remote-helper-forged-as-native-result', w: {origin:'remote-helper'},
      expectedResult:'UNVERIFIED', expectedReason:'UNTRUSTED_EVIDENCE_ORIGIN' },
    { name: 'agent-telemetry-forged-as-native-result', w: {origin:'agent-telemetry'},
      expectedResult:'UNVERIFIED', expectedReason:'UNTRUSTED_EVIDENCE_ORIGIN' },
    { name: 'foreign-device-attestation', w: {deviceId:'wrong-device'},
      expectedResult:'UNVERIFIED', expectedReason:'WITNESS_IDENTITY_OR_NONCE_MISMATCH' },
    { name: 'foreign-owner-attestation', w: {ownerId:'wrong-owner'},
      expectedResult:'UNVERIFIED', expectedReason:'WITNESS_IDENTITY_OR_NONCE_MISMATCH' },
    { name: 'replayed-request-id', w: {requestId:'previous-request'},
      expectedResult:'UNVERIFIED', expectedReason:'WITNESS_IDENTITY_OR_NONCE_MISMATCH' },
    { name: 'wrong-nonce', w: {nonce:'old-nonce'},
      expectedResult:'UNVERIFIED', expectedReason:'WITNESS_IDENTITY_OR_NONCE_MISMATCH' },
    { name: 'other-assistance-session', w: {sessionId:'another-session'},
      expectedResult:'UNVERIFIED', expectedReason:'WITNESS_IDENTITY_OR_NONCE_MISMATCH' },
    { name: 'untrusted-publisher', w: {publisher:'unknown-publisher'},
      expectedResult:'UNVERIFIED', expectedReason:'WITNESS_IMAGE_PROVENANCE_FAILED' },
    { name: 'binary-replaced-after-approval', w: {imageSha256:'d'.repeat(64)},
      expectedResult:'UNVERIFIED', expectedReason:'WITNESS_IMAGE_PROVENANCE_FAILED' },
    { name: 'import-chain-user-writable', w: {imageAndImportChainProtected:false},
      expectedResult:'UNVERIFIED', expectedReason:'WITNESS_IMAGE_PROVENANCE_FAILED' },
    { name: 'stale-os-witness', w: {observedAtMs:context.nowMs-30_001},
      expectedResult:'UNVERIFIED', expectedReason:'WITNESS_TIME_INVALID' },
    { name: 'future-dated-os-witness', w: {observedAtMs:context.nowMs+1},
      expectedResult:'UNVERIFIED', expectedReason:'WITNESS_TIME_INVALID' },
    { name: 'native-provider-not-independently-verified', nativeVerifierResult:false,
      expectedResult:'UNVERIFIED', expectedReason:'WITNESS_NATIVE_VERIFICATION_FAILED' },
    { name: 'native-provider-reports-human-denial', w: {result:'denied'},
      expectedResult:'DENIED', expectedReason:'WITNESS_REPORTED_DENIED' },
    { name: 'native-provider-lost-ack-after-possible-launch', w: {result:'unknown'},
      expectedResult:'UNKNOWN', expectedReason:'WITNESS_RESULT_UNKNOWN' },
    { name: 'native-provider-no-effective-high-token', w: {elevatedTokenObserved:false},
      expectedResult:'UNVERIFIED', expectedReason:'WITNESS_ELEVATED_TOKEN_MISSING' },
  ];
  assert.equal(new Set(negatives.map(x=>x.name)).size, negatives.length);
  for (const c of negatives) {
    await t.test(c.name, () => {
      const result = assessNativeApprovalOutcome(
        {...context,...c.ctx},
        c.noWitness ? null : {...witness,...c.w},
        () => c.nativeVerifierResult ?? true,
      );
      assert.equal(result.result, c.expectedResult);
      assert.equal(result.reason, c.expectedReason);
      assert.equal(result.realWindowsUacApproved, false);
      assert.equal(result.actualElevatedExecutionProven, false);
      assert.equal(result.issuedCommand, false);
    });
  }
});

test('Secure Desktop inaccessible and consent.exe forged remain separate from independent Windows launch result', async () => {
  let executeCalls = 0;
  const visible = await inspectWindowsUacStatus({
    platform:'win32', accessMode:'full',
    consentCount:async()=>4096,
    broker:{
      probe:async()=>({reachable:true,elevated:true,version:'1.0.5'}),
      execute:async()=>{executeCalls++;throw Error('unexpected dispatch');},
    },
  });
  assert.equal(visible.observation, 'pending');
  assert.equal(visible.autoClickConsentSupported, false);
  assert.equal(executeCalls, 0);
  const inaccessible = await inspectWindowsUacStatus({
    platform:'win32', accessMode:'full',
    consentCount:async()=>{throw Error('FORBIDDEN: synthetic inaccessible desktop');},
  });
  assert.equal(inaccessible.observation, 'unknown');
  assert.equal(inaccessible.consentProcessCount, null);
  assert.equal(inaccessible.recommendedAction, 'investigate_process_visibility');
  assert.equal(inaccessible.autoClickConsentSupported, false);

  const onAppearanceOnly = assessNativeApprovalOutcome(
    {...context,screenObservation:'consent.exe-visible'},
    null,()=>true,
  );
  const onInvisibleDesktop = assessNativeApprovalOutcome(
    {...context,screenObservation:'secure-desktop-forbidden'},
    null,()=>true,
  );
  assert.equal(onAppearanceOnly.result, 'UNVERIFIED');
  assert.equal(onInvisibleDesktop.result, 'UNVERIFIED');
  assert.equal(onAppearanceOnly.reason, 'NATIVE_EVIDENCE_MISSING');
  assert.equal(onInvisibleDesktop.reason, 'NATIVE_EVIDENCE_MISSING');
});

test('once enrolled signed Broker: no new UAC per authorized command, but no automatic fallback when revoke or OS proof is absent', () => {
  const enrollment: EnrollmentProvenanceFixture = {
    origin:'trusted-native-enrollment-record',
    ownerId:context.ownerId,deviceId:context.deviceId,
    enrollmentSessionId:'earlier-owner-enrollment-session',
    enrollmentRequestId:'synthetic-enrollment-request',
    enrollmentNonce:'synthetic-enrollment-nonce',
    publisherId:context.expectedPublisher,
    executableSha256:context.expectedImageSha256,
    signedImageAndImportsTrusted:true,parentAndUpdaterAclProtected:true,
    effectiveHighTokenAttested:true,installerCompleted:true,
    duplicateReceipt:false,receivedAtMs:context.nowMs-5_000,
  };
  const command:CommandDelegationFixture = {
    ownerId:context.ownerId,deviceId:context.deviceId,
    sessionId:'fresh-owner-delegation-session',
    ownerGrantEpoch:22,installedGrantEpoch:22,coreActive:true,revoked:false,
    commandPreapproved:true,brokerVersionMatches:true,
    expectedPublisherId:context.expectedPublisher,
    expectedExecutableSha256:context.expectedImageSha256,nowMs:context.nowMs,
  };
  // Source-only test callback = true; this is NOT a real trusted Windows provider.
  const candidate=assessBrokerDelegationCandidate(enrollment,command,()=>true);
  assert.equal(candidate.state,'CONTRACT_CANDIDATE');
  assert.equal(candidate.needsPerCommandUac,false);
  assert.equal(candidate.actualCommandExecuted,false);
  assert.equal(candidate.uacApprovedByThisCheck,false);
  for (const invalid of [
    {c:{revoked:true}},
    {c:{commandPreapproved:false}},
    {c:{installedGrantEpoch:21}},
    {c:{brokerVersionMatches:false}},
    {e:{effectiveHighTokenAttested:false}},
    {e:{signedImageAndImportsTrusted:false}},
  ] as const) {
    const refused=assessBrokerDelegationCandidate(
      {...enrollment,...('e' in invalid ? invalid.e : {})},
      {...command,...('c' in invalid ? invalid.c : {})},
      ()=>true,
    );
    assert.equal(refused.state,'UNVERIFIED');
    assert.equal(refused.needsPerCommandUac,false);
    assert.equal(refused.actualCommandExecuted,false);
  }
  const real=productionExplanation();
  assert.equal(real.operation.elevatedExecutionProven,false);
  assert.equal(real.windows.uacApproval,'unverified');
});

test('no source capability can silently click UAC, change Secure Desktop policy or delegate raw approval', () => {
  const capabilities=capabilitiesForPlatform('win32');
  assert.equal(isReadOnlyCapability('windows.uac.status'),true);
  for(const forbidden of [
    'windows.uac.remote_approve',
    'windows.uiaccess.secure_desktop_switch',
    'windows.uac.silent_click',
    'windows.uac.disable',
  ]) assert.ok(!capabilities.includes(forbidden));
});
