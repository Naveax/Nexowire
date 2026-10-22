import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWindowsUacStatus} from '../src/agent/windows-uac-status.js';
import {explainDeviceAuthorization, type DeviceAuthorizationFacts} from '../src/security/authorization-explain.js';
import {capabilitiesForPlatform,isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {
  classifySourceOnlyCrossBranchCase, syntheticCrossBranchCase,
  type CrossBranchCase, type CrossBranchOutcome,
} from './fixtures/qa27-core-broker-external-authority-contract.js';

const baseline=syntheticCrossBranchCase;
function caseWith(
  values:Partial<{
    enrollment:Partial<CrossBranchCase['enrollment']>;
    broker:Partial<CrossBranchCase['broker']>;
    authority:Partial<CrossBranchCase['authority']>;
    remote:Partial<CrossBranchCase['remote']>;
  }>={}
):CrossBranchCase {
  return {
    enrollment:{...baseline.enrollment,...values.enrollment},
    broker:{...baseline.broker,...values.broker},
    authority:{...baseline.authority,...values.authority},
    remote:{...baseline.remote,...values.remote},
  };
}
function noPhysicalClaim(out:CrossBranchOutcome) {
  assert.equal(out.realUacApprovalProven,false);
  assert.equal(out.canExecutePrivilegedCommand,false);
  assert.equal(out.submittedToBroker,false);
  assert.equal(out.noPerCommandUacFallback,true);
  assert.equal(out.safeToRetryUnknown,false);
}
function productionExplain():ReturnType<typeof explainDeviceAuthorization>{
  const now=new Date('2026-10-21T17:35:00.000Z');
  const facts:DeviceAuthorizationFacts={
    deviceId:'device27',ownerAccountId:'owner27',requesterAccountId:'owner27',
    requesterRole:'user',accessMode:'full',online:true,
    privilegeMode:'broker',adminBridgeReady:true,rootLease:null,
    corePreference:{ownerAccountId:'owner27',enabled:true,updatedAt:now.toISOString()},
    bridgePreference:{ownerAccountId:'owner27',desiredMode:'on',updatedAt:now.toISOString()},
    now,
  };
  return explainDeviceAuthorization(facts,'windows.task.control');
}
test('OS-approved once-enrolled Broker, owner absent later: only contract-candidate, never automatic admin execution',()=>{
  const x=caseWith({authority:{ownerPhysicallyPresentNow:false}});
  const out=classifySourceOnlyCrossBranchCase(x);
  assert.equal(out.result,'CONTRACT_CANDIDATE');
  assert.equal(out.reason,'SOURCE_CONTRACT_ONLY');
  noPhysicalClaim(out);
  const production=productionExplain();
  assert.equal(production.core.state,'PAUSED_UNVERIFIED');
  assert.equal(production.operation.elevatedExecutionProven,false);
  assert.equal(production.windows.uacApproval,'unverified');
  assert.equal(production.adminBridge.authenticatedBrokerHealth,'unverified');
});
test('owner absent during approval cannot substitute Remote Assistance or consent.exe for native OS evidence',async()=>{
  let dispatchCalls=0;
  const fakeBroker={
    probe:async()=>({reachable:true,elevated:true,version:'1.0.5'}),
    execute:async()=>{dispatchCalls++;return null;},
  };
  const observed=await inspectWindowsUacStatus({
    platform:'win32',accessMode:'full',consentCount:async()=>7,
    broker:fakeBroker,
  });
  assert.equal(observed.observation,'pending');
  assert.equal(observed.autoClickConsentSupported,false);
  assert.equal(dispatchCalls,0);
  for(const origin of [
    'remote-assistance-session-only','consent.exe-count',
    'secure-desktop-unavailable','self-reported-helper',
  ] as const){
    const outcome=classifySourceOnlyCrossBranchCase(caseWith({
      enrollment:{
        origin,ownerWasPhysicallyPresentAtEnrollment:false,
        localOsHumanApprovalRecorded:false,independentOsResultVerified:false,
      },
    }));
    assert.equal(outcome.result,'BLOCKED',origin);
    assert.equal(outcome.reason,'OS_ENROLLMENT_NOT_AUTHENTICATED');
    noPhysicalClaim(outcome);
  }
  const inaccessible=await inspectWindowsUacStatus({
    platform:'win32',accessMode:'full',
    consentCount:async()=>{throw Error('FORBIDDEN: no Secure Desktop visibility');},
  });
  assert.equal(inaccessible.observation,'unknown');
  assert.equal(inaccessible.consentProcessCount,null);
  assert.equal(inaccessible.recommendedAction,'investigate_process_visibility');
  assert.equal(inaccessible.autoClickConsentSupported,false);
});
test('local OS approval and later physical owner absence differ from unauthorized new remote enrollment',()=>{
  const alreadyEnrolled=classifySourceOnlyCrossBranchCase(caseWith({
    enrollment:{ownerWasPhysicallyPresentAtEnrollment:true},
    authority:{ownerPhysicallyPresentNow:false},
  }));
  assert.equal(alreadyEnrolled.result,'CONTRACT_CANDIDATE');
  noPhysicalClaim(alreadyEnrolled);
  // A supervised OS-approved remote enrollment still requires a separately
  // authenticated native result; a physical-console presence bit is not
  // an authorization oracle, either positive or negative.
  const syntheticRemoteOsAttestation=classifySourceOnlyCrossBranchCase(caseWith({
    enrollment:{
      ownerWasPhysicallyPresentAtEnrollment:false,
      localOsHumanApprovalRecorded:true,
      independentOsResultVerified:true,
    },
  }));
  assert.equal(syntheticRemoteOsAttestation.result,'CONTRACT_CANDIDATE');
  noPhysicalClaim(syntheticRemoteOsAttestation);
  const noResult=classifySourceOnlyCrossBranchCase(caseWith({
    enrollment:{origin:'remote-assistance-session-only',ownerWasPhysicallyPresentAtEnrollment:false},
  }));
  assert.equal(noResult.result,'BLOCKED');
});
test('#700 native publisher/ACL + #702 external claim contract cross-negative matrix (separate unmerged code)',async t=>{
  const cases:ReadonlyArray<{
    label:string;
    changes:Parameters<typeof caseWith>[0];
    result:'BLOCKED'|'UNKNOWN';
    reason:string;
  }>=[
    {label:'missing-local-OS-approved-enrollment',changes:{enrollment:{independentOsResultVerified:false}},result:'BLOCKED',reason:'OS_ENROLLMENT_NOT_AUTHENTICATED'},
    {label:'missing-effective-OS-token-on-enrollment',changes:{enrollment:{osEffectiveHighTokenVerified:false}},result:'BLOCKED',reason:'OS_ENROLLMENT_NOT_AUTHENTICATED'},
    {label:'OS-installer-result-unconfirmed',changes:{enrollment:{osInstallerCompleted:false}},result:'BLOCKED',reason:'OS_ENROLLMENT_NOT_AUTHENTICATED'},
    {label:'wrong-original-device',changes:{enrollment:{deviceId:'other-device'}},result:'BLOCKED',reason:'ENROLLMENT_IDENTITY_MISMATCH'},
    {label:'wrong-owner-pairing',changes:{enrollment:{ownerId:'former-owner'}},result:'BLOCKED',reason:'ENROLLMENT_IDENTITY_MISMATCH'},
    {label:'untrusted-Broker-publisher',changes:{broker:{signedPinnedPublisher:false}},result:'BLOCKED',reason:'BROKER_EXE_IMPORT_UPDATER_TRUST_INCOMPLETE'},
    {label:'unprotected-Broker-EXE-ancestor',changes:{broker:{exeAndAncestorsAclVerified:false}},result:'BLOCKED',reason:'BROKER_EXE_IMPORT_UPDATER_TRUST_INCOMPLETE'},
    {label:'unprotected-import-updater-ancestor',changes:{broker:{everyImportAndUpdaterAncestorAclVerified:false}},result:'BLOCKED',reason:'BROKER_EXE_IMPORT_UPDATER_TRUST_INCOMPLETE'},
    {label:'caller-provided-incomplete-import-list',changes:{broker:{independentImportEnumeration:false}},result:'BLOCKED',reason:'BROKER_EXE_IMPORT_UPDATER_TRUST_INCOMPLETE'},
    {label:'forged-release-rollback-manifest',changes:{broker:{signedReleaseAndRollbackManifest:false}},result:'BLOCKED',reason:'BROKER_EXE_IMPORT_UPDATER_TRUST_INCOMPLETE'},
    {label:'replaced-DLL-publisher-or-hash',changes:{broker:{importedPublishersAndHashesVerified:false}},result:'BLOCKED',reason:'BROKER_EXE_IMPORT_UPDATER_TRUST_INCOMPLETE'},
    {label:'recycled-PID-creation-FILETIME',changes:{broker:{processPidCreationFiletimeMatches:false}},result:'BLOCKED',reason:'BROKER_PROCESS_IDENTITY_UNVERIFIED'},
    {label:'wrong-file-ID-or-volume',changes:{broker:{volumeSerialAndFileIdMatches:false}},result:'BLOCKED',reason:'BROKER_PROCESS_IDENTITY_UNVERIFIED'},
    {label:'running-image-handle-mismatch',changes:{broker:{runningImageHandleHashMatches:false}},result:'BLOCKED',reason:'BROKER_PROCESS_IDENTITY_UNVERIFIED'},
    {label:'low-priv-DUP_HANDLE-possible',changes:{broker:{noLowPrivProcessDupHandle:false}},result:'BLOCKED',reason:'BROKER_PROCESS_IDENTITY_UNVERIFIED'},
    {label:'token-not-High-or-admin-deny-only',changes:{broker:{effectiveHighTokenAndEnabledAdmins:false}},result:'BLOCKED',reason:'BROKER_EFFECTIVE_HIGH_TOKEN_UNVERIFIED'},
    {label:'no-physical-Broker-install-witness',changes:{broker:{physicalBrokerDeploymentAttested:false}},result:'BLOCKED',reason:'PHYSICAL_BROKER_NOT_ATTESTED'},
    {label:'CORE-revoked',changes:{authority:{revoked:true}},result:'BLOCKED',reason:'OWNER_SESSION_OR_EPOCH_REVOKED'},
    {label:'CORE-disabled',changes:{authority:{coreEnabled:false}},result:'BLOCKED',reason:'OWNER_SESSION_OR_EPOCH_REVOKED'},
    {label:'stale-owner-epoch-after-re-pair',changes:{authority:{installedOwnerEpoch:6}},result:'BLOCKED',reason:'OWNER_SESSION_OR_EPOCH_REVOKED'},
    {label:'revoke-and-drain-pending',changes:{authority:{revokeAndDrainPending:true}},result:'BLOCKED',reason:'OWNER_SESSION_OR_EPOCH_REVOKED'},
    {label:'missing-authenticated-session',changes:{authority:{authenticatedSessionId:''}},result:'BLOCKED',reason:'OWNER_SESSION_OR_EPOCH_REVOKED'},
    {label:'capability-not-preapproved',changes:{authority:{capabilityPreapproved:false}},result:'BLOCKED',reason:'CAPABILITY_OR_BROKER_VERSION_DENIED'},
    {label:'Broker-version-mismatch',changes:{authority:{brokerVersionMatch:false}},result:'BLOCKED',reason:'CAPABILITY_OR_BROKER_VERSION_DENIED'},
    {label:'external-CAS-offline',changes:{remote:{onlineExternalCas:false}},result:'UNKNOWN',reason:'EXTERNAL_AUTHORITY_UNAVAILABLE'},
    {label:'external-claim-forged-signature',changes:{remote:{issuerSignatureVerified:false}},result:'BLOCKED',reason:'EXTERNAL_CLAIM_SCOPE_OR_SIGNATURE_INVALID'},
    {label:'external-claim-reused',changes:{remote:{claimSingleUse:false}},result:'BLOCKED',reason:'EXTERNAL_CLAIM_SCOPE_OR_SIGNATURE_INVALID'},
    {label:'external-claim-stale-owner',changes:{remote:{claimOwnerId:'former-owner'}},result:'BLOCKED',reason:'EXTERNAL_CLAIM_SCOPE_OR_SIGNATURE_INVALID'},
    {label:'external-claim-cross-device',changes:{remote:{claimDeviceId:'other-device'}},result:'BLOCKED',reason:'EXTERNAL_CLAIM_SCOPE_OR_SIGNATURE_INVALID'},
    {label:'external-claim-stale-session',changes:{remote:{claimSessionId:'logged-out-session'}},result:'BLOCKED',reason:'EXTERNAL_CLAIM_SCOPE_OR_SIGNATURE_INVALID'},
    {label:'external-claim-revoked-generation',changes:{remote:{claimOwnerEpoch:6}},result:'BLOCKED',reason:'EXTERNAL_CLAIM_SCOPE_OR_SIGNATURE_INVALID'},
    {label:'external-claim-other-request',changes:{remote:{claimRequestId:'another-request'}},result:'BLOCKED',reason:'EXTERNAL_CLAIM_SCOPE_OR_SIGNATURE_INVALID'},
    {label:'external-claim-wrong-fingerprint',changes:{remote:{claimFingerprint:'d'.repeat(64)}},result:'BLOCKED',reason:'EXTERNAL_CLAIM_SCOPE_OR_SIGNATURE_INVALID'},
    {label:'external-claim-expired',changes:{remote:{claimExpired:true}},result:'BLOCKED',reason:'EXTERNAL_CLAIM_SCOPE_OR_SIGNATURE_INVALID'},
    {label:'remote-revocation-current-generation-unverified',changes:{remote:{remoteRevokeGenerationCurrent:false}},result:'BLOCKED',reason:'EXTERNAL_CLAIM_SCOPE_OR_SIGNATURE_INVALID'},
    {label:'lost-ACK-after-possible-dispatch',changes:{remote:{claimLostAck:true}},result:'UNKNOWN',reason:'DISPATCH_ALREADY_POSSIBLE_UNKNOWN'},
    {label:'native-write-possibly-started',changes:{remote:{possibleNativeWriteStarted:true}},result:'UNKNOWN',reason:'DISPATCH_ALREADY_POSSIBLE_UNKNOWN'},
    {label:'previous-dispatch-observed',changes:{authority:{dispatchAlreadyObserved:true}},result:'UNKNOWN',reason:'DISPATCH_ALREADY_POSSIBLE_UNKNOWN'},
  ];
  assert.equal(new Set(cases.map(c=>c.label)).size,cases.length);
  for(const c of cases){
    await t.test(c.label,()=>{
      const outcome=classifySourceOnlyCrossBranchCase(caseWith(c.changes));
      assert.equal(outcome.result,c.result);
      assert.equal(outcome.reason,c.reason);
      noPhysicalClaim(outcome);
    });
  }
});
test('QA27 missing #712 nonce barrier: preapproved owner-absent CORE stays eligible, forged consent cannot revive revoked or replayed authority',async()=>{
  // This is a *pure fixture* of an earlier locally OS-approved Broker. A real
  // Windows token, Authenticode signature and monotonic external CAS are NOT
  // obtained here. A valid preapproval must not produce per-command UAC.
  const healthy=caseWith({
    authority:{ownerPhysicallyPresentNow:false,dispatchChallengeNonce:'b'.repeat(64)},
    remote:{claimChallengeNonce:'b'.repeat(64)},
  });
  const eligible=classifySourceOnlyCrossBranchCase(healthy);
  assert.equal(eligible.result,'CONTRACT_CANDIDATE');
  noPhysicalClaim(eligible);

  let privilegedDispatches=0;
  const forgedBroker={
    probe:async()=>({reachable:true,elevated:true,version:'1.0.5'}),
    execute:async()=>{privilegedDispatches++;throw Error('Unexpected privileged dispatch');},
  };
  const forgedPrompt=await inspectWindowsUacStatus({
    platform:'win32',accessMode:'full',consentCount:async()=>1,
    broker:forgedBroker,
  });
  assert.equal(forgedPrompt.observation,'pending');
  assert.equal(forgedPrompt.autoClickConsentSupported,false);
  assert.equal(privilegedDispatches,0);

  // Historical Ed25519 permit can be *correctly signed*, yet carried forward
  // from a rolled-back journal/another dispatch. New challenge MUST fail even
  // with unchanged owner, session, capability, request and grant generation.
  const replay=classifySourceOnlyCrossBranchCase(caseWith({
    authority:{ownerPhysicallyPresentNow:false,dispatchChallengeNonce:'b'.repeat(64)},
    remote:{claimChallengeNonce:'a'.repeat(64),issuerSignatureVerified:true,claimSingleUse:true},
  }));
  assert.equal(replay.result,'BLOCKED');
  assert.equal(replay.reason,'EXTERNAL_CLAIM_SCOPE_OR_SIGNATURE_INVALID');
  noPhysicalClaim(replay);

  // Even a fresh matching challenge cannot reauthorize a revoked CORE lease.
  // Nor can the forged consent.exe process, elevated Broker probe or absent
  // physical owner request a new UAC prompt as a fallback.
  const revoked=classifySourceOnlyCrossBranchCase(caseWith({
    authority:{
      ownerPhysicallyPresentNow:false,revoked:true,
      dispatchChallengeNonce:'b'.repeat(64),
    },
    remote:{claimChallengeNonce:'b'.repeat(64),issuerSignatureVerified:true},
  }));
  assert.equal(revoked.result,'BLOCKED');
  assert.equal(revoked.reason,'OWNER_SESSION_OR_EPOCH_REVOKED');
  noPhysicalClaim(revoked);
  assert.equal(productionExplain().windows.uacApproval,'unverified');
});
test('QA27 #743 composed gate: inspected DACL is not token-aware AccessCheck and declared imports are not a complete loader graph',()=>{
  // #741 independently tests signed native/CAS nonce and owner-epoch readback.
  // #743 tests Windows TEMP native ACL traversal. Neither proves that a
  // caller-provided import list is a complete loader dependency tree, or
  // that ACE enumeration is an effective low-priv Windows AccessCheck.
  const allReadbacksAppearHealthy=caseWith({
    authority:{
      ownerPhysicallyPresentNow:false,
      dispatchChallengeNonce:'f'.repeat(64),
      revoked:false,
    },
    remote:{
      claimChallengeNonce:'f'.repeat(64),
      issuerSignatureVerified:true,
      claimSingleUse:true,
    },
  });
  const syntheticCandidate=classifySourceOnlyCrossBranchCase(allReadbacksAppearHealthy);
  assert.equal(syntheticCandidate.result,'CONTRACT_CANDIDATE');
  noPhysicalClaim(syntheticCandidate);

  const discoveredOnlyFirstLevel=classifySourceOnlyCrossBranchCase(caseWith({
    broker:{
      exeAndAncestorsAclVerified:true,
      everyImportAndUpdaterAncestorAclVerified:true,
      independentImportEnumeration:true,
      transitiveImportsIndependentlyEnumerated:false,
    },
  }));
  assert.equal(discoveredOnlyFirstLevel.result,'BLOCKED');
  assert.equal(discoveredOnlyFirstLevel.reason,'BROKER_EXE_IMPORT_UPDATER_TRUST_INCOMPLETE');
  noPhysicalClaim(discoveredOnlyFirstLevel);

  const aclRulesObservedButNoAccessCheck=classifySourceOnlyCrossBranchCase(caseWith({
    broker:{
      exeAndAncestorsAclVerified:true,
      everyImportAndUpdaterAncestorAclVerified:true,
      transitiveImportsIndependentlyEnumerated:true,
      nativeLowPrivilegeEffectiveAccessCheckCompleted:false,
    },
  }));
  assert.equal(aclRulesObservedButNoAccessCheck.result,'BLOCKED');
  assert.equal(aclRulesObservedButNoAccessCheck.reason,'BROKER_EXE_IMPORT_UPDATER_TRUST_INCOMPLETE');
  noPhysicalClaim(aclRulesObservedButNoAccessCheck);
  // These booleans are synthetic assertions, never an actual native
  // publisher/AccessCheck provider or permit to dispatch.
  assert.equal(productionExplain().operation.elevatedExecutionProven,false);
});
test('QA27 #756/#747/#757: real low-token Broker boundary and external atomic commit must both survive cross-Hub revoke',async t=>{
  // Single independent COMPOSITION test. #756 already tests disposable TEMP
  // caller-token access/PID; #747 already reproduces the two-Hub race with
  // an injected fake native callback. Neither is a physically installed HIGH
  // Broker, complete transitive DLL dependency witness or real remote CAS.
  // This acceptance oracle never calls a native effect or UAC.
  const initiallyAuthorized=caseWith({
    enrollment:{origin:'local-os-elevated-launch-attestation'},
    authority:{
      ownerPhysicallyPresentNow:false, // no repeat UAC after real enrollment
      revokeAndDrainPending:false,
      dispatchChallengeNonce:'e'.repeat(64),
    },
    remote:{
      issuerSignatureVerified:true,
      claimChallengeNonce:'e'.repeat(64),
      remoteRevokeGenerationCurrent:true,
      finalNativeDispatchAuthority:'synthetic-external-atomic-commit',
      revokeCommitOrder:'no-revoke',
    },
  });
  const candidate=classifySourceOnlyCrossBranchCase(initiallyAuthorized);
  assert.equal(candidate.result,'CONTRACT_CANDIDATE');
  assert.equal(candidate.reason,'SOURCE_CONTRACT_ONLY');
  noPhysicalClaim(candidate);
  let nativeEffects=0; // No invocations, not an actual Broker mock.

  const negatives:ReadonlyArray<{
    name:string;changes:NonNullable<Parameters<typeof caseWith>[0]>;
    result:'BLOCKED'|'UNKNOWN';reason:string;
  }>=[
    {
      name:'declared EXE DLL updater ACL without independently complete transitive dependency DAG',
      changes:{broker:{
        everyImportAndUpdaterAncestorAclVerified:true,
        transitiveImportsIndependentlyEnumerated:false,
        nativeLowPrivilegeEffectiveAccessCheckCompleted:true,
        separateLowPrivilegeTokenAndInstalledTreeAccessCheckVerified:true,
      }},
      result:'BLOCKED',reason:'BROKER_EXE_IMPORT_UPDATER_TRUST_INCOMPLETE',
    },
    {
      name:'TEMP current-user CreateFile and PID FILETIME PASS but no separate restricted low-token installed-tree AccessCheck',
      changes:{broker:{
        transitiveImportsIndependentlyEnumerated:true,
        nativeLowPrivilegeEffectiveAccessCheckCompleted:true,
        separateLowPrivilegeTokenAndInstalledTreeAccessCheckVerified:false,
      }},
      result:'BLOCKED',reason:'BROKER_SEPARATE_LOW_PRIVILEGE_ACCESS_UNVERIFIED',
    },
    {
      name:'late authentic Ed25519 permit and fresh nonce with merely signed post-read, no atomic native dispatch commit',
      changes:{remote:{
        issuerSignatureVerified:true,claimChallengeNonce:'e'.repeat(64),
        finalNativeDispatchAuthority:'signed-status-readback',
        revokeCommitOrder:'no-revoke',
      }},
      result:'BLOCKED',reason:'EXTERNAL_ATOMIC_NATIVE_COMMIT_UNVERIFIED',
    },
    {
      name:'Hub A process-local green flag while Hub B can start revoke',
      changes:{remote:{
        finalNativeDispatchAuthority:'process-local-flag',
        revokeCommitOrder:'no-revoke',
      }},
      result:'BLOCKED',reason:'EXTERNAL_ATOMIC_NATIVE_COMMIT_UNVERIFIED',
    },
    {
      name:'Hub B revoke-start linearizes before Hub A actual native-effect commit despite pre-revoke correctly signed permit',
      changes:{remote:{
        issuerSignatureVerified:true,
        claimSingleUse:true,
        remoteRevokeGenerationCurrent:true, // a stale snapshot can say true
        finalNativeDispatchAuthority:'synthetic-external-atomic-commit',
        revokeCommitOrder:'revoke-start-before-commit',
      }},
      result:'BLOCKED',reason:'REVOKE_START_PRECEDES_ATOMIC_COMMIT',
    },
    {
      name:'effect admitted BEFORE revoke-start cannot be relabeled never executed or blindly replayed',
      changes:{remote:{
        finalNativeDispatchAuthority:'synthetic-external-atomic-commit',
        revokeCommitOrder:'commit-before-revoke',
      }},
      result:'UNKNOWN',reason:'COMMIT_ORDER_OR_EFFECT_UNKNOWN_NO_REPLAY',
    },
    {
      name:'unknown native-effect commit order remains UNKNOWN without replay',
      changes:{remote:{
        finalNativeDispatchAuthority:'synthetic-external-atomic-commit',
        revokeCommitOrder:'unknown',
      }},
      result:'UNKNOWN',reason:'COMMIT_ORDER_OR_EFFECT_UNKNOWN_NO_REPLAY',
    },
    {
      name:'owner revoked CORE regardless of preapproved Broker, signed permit and matching nonce',
      changes:{authority:{revoked:true,ownerPhysicallyPresentNow:false}},
      result:'BLOCKED',reason:'OWNER_SESSION_OR_EPOCH_REVOKED',
    },
  ];
  // Use the same fresh nonce/owner scope as the candidate in each synthetic
  // case unless that specific field is under test. A forged/stale consent.exe
  // count never enters these authoritative fields.
  assert.equal(new Set(negatives.map(x=>x.name)).size,negatives.length);
  for(const c of negatives){
    await t.test(c.name,()=>{
      const scenario:CrossBranchCase={
        enrollment:{...initiallyAuthorized.enrollment,...c.changes.enrollment},
        broker:{...initiallyAuthorized.broker,...c.changes.broker},
        authority:{...initiallyAuthorized.authority,...c.changes.authority},
        remote:{...initiallyAuthorized.remote,...c.changes.remote},
      };
      const result=classifySourceOnlyCrossBranchCase(scenario);
      assert.equal(result.result,c.result);
      assert.equal(result.reason,c.reason);
      noPhysicalClaim(result);
      assert.equal(nativeEffects,0);
    });
  }
  assert.equal(productionExplain().operation.elevatedExecutionProven,false);
});

test('QA27 #795/#726: preference-only CORE and ROOT exactly T+900000ms never become native elevated dispatch proof',()=>{
  // Independent real read-only policy projection, NOT the #23 web/app.js
  // DOM renderer regression. Its UI owner must separately fix stale badges.
  const issuedAt=Date.parse('2026-10-22T12:00:00.000Z');
  const expiresAt=issuedAt+900_000;
  const factsAt=(when:number):DeviceAuthorizationFacts=>({
    deviceId:'device27',ownerAccountId:'owner27',
    requesterAccountId:'owner27',requesterRole:'user',
    accessMode:'full',online:true,privilegeMode:'broker',
    adminBridgeReady:true,
    rootLease:{
      ownerAccountId:'owner27',expiresAt:new Date(expiresAt).toISOString(),
    },
    // A recorded UI/owner preference is NOT physical OS-approved enrollment.
    corePreference:{
      ownerAccountId:'owner27',enabled:true,
      updatedAt:new Date(issuedAt).toISOString(),
    },
    bridgePreference:{
      ownerAccountId:'owner27',desiredMode:'on',
      updatedAt:new Date(issuedAt).toISOString(),
    },
    now:new Date(when),
  });
  const before=explainDeviceAuthorization(
    factsAt(expiresAt-1),'windows.service.control');
  const atBoundary=explainDeviceAuthorization(
    factsAt(expiresAt),'windows.service.control');

  // Diagnostic ROOT time can still be positive 1 ms before expiration,
  // but the legacy record has no independent session-bound root authority.
  assert.equal(before.root.leaseUnexpired,true);
  assert.equal(before.root.policyActive,false);
  assert.equal(before.root.sessionBound,false);
  assert.equal(atBoundary.root.leaseUnexpired,false);
  assert.equal(atBoundary.root.expiresAt,null);
  assert.ok(atBoundary.operation.reasons.includes(
    'ROOT_LEASE_EXPIRED_OR_REVOKED'));

  // Neither preference approval, Broker readiness telemetry nor a ROOT
  // countdown authorizes actual OS HIGH or native external CAS dispatch.
  // 'not-proven' MUST be treated as DENY by the UI/dispatch owner.
  for(const source of [before,atBoundary]){
    assert.equal(source.core.enabled,true);
    assert.equal(source.core.state,'PAUSED_UNVERIFIED');
    assert.equal(source.adminBridge.preferenceApplied,false);
    assert.equal(source.adminBridge.authenticatedBrokerHealth,'unverified');
    assert.equal(source.windows.adminToken,'unverified');
    assert.equal(source.windows.uacApproval,'unverified');
    assert.equal(source.operation.privilegeRequirement,'elevated');
    assert.equal(source.operation.decision,'not-proven');
    assert.equal(source.operation.elevatedExecutionProven,false);
    assert.equal(source.operation.providerAuthorizationProven,false);
  }

  // The #27 separate source oracle also refuses attempted promotion when
  // a claimed preapproved CORE has no genuine independent OS bootstrap.
  const unverified=classifySourceOnlyCrossBranchCase(caseWith({
    enrollment:{
      independentOsResultVerified:false,
      localOsHumanApprovalRecorded:false,
    },
    authority:{ownerPhysicallyPresentNow:false,coreEnabled:true},
  }));
  assert.equal(unverified.result,'BLOCKED');
  assert.equal(unverified.reason,'OS_ENROLLMENT_NOT_AUTHENTICATED');
  noPhysicalClaim(unverified);
});

test('no UAC auto-click, secure-desktop bypass or arbitrary Broker dispatch capability appeared',()=>{
  const win=capabilitiesForPlatform('win32');
  assert.equal(isReadOnlyCapability('windows.uac.status'),true);
  for(const c of [
    'windows.uac.silent_approve','windows.secure_desktop.switch',
    'windows.uac.auto_click','windows.remote_assistance.uac_grant',
  ]) assert.ok(!win.includes(c),c);
});
