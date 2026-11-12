import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewWindowsRestrictedWorkerPreflight,
  type RestrictedWorkerProposal,
  type WindowsPhysicalWitnessClaims,
  type RestrictedWorkerFinding,
} from '../src/security/windows-restricted-worker-preflight.js';

const proposal = (): RestrictedWorkerProposal => ({
  targetPlatform: 'win32', ownerId: 'fixture-owner', deviceId: 'fixture-device',
  taskId: 'fixture-task', requestId: 'fixture-request', worktreeId: 'fixture-worktree',
  sourceSha: 'a'.repeat(40), ownerEpoch: 2, observedOwnerEpoch: 2,
  observedAtMs: 1_000, grantExpiresAtMs: 2_000, grantState: 'ACTIVE',
  isolationMode: 'restricted-token', launchPath: 'future-native-restricted-provider',
  fallbackToAmbientSpawn: false, environment: 'explicit-allowlist',
  handleInheritance: 'explicit-stdio-only',
  requestedNetworkPolicy: 'deny-all-including-loopback',
});

const claims = (): WindowsPhysicalWitnessClaims => ({
  ownerId: 'fixture-owner', deviceId: 'fixture-device', taskId: 'fixture-task',
  requestId: 'fixture-request', ownerEpoch: 2,
  rootPid: 5551, guardianPid: 5552, rootCreationFiletime: '134000000000000000',
  tokenUserSid: 'S-1-5-21-111-222-333-1001', expectedTaskSid: 'S-1-5-21-111-222-333-1002',
  restrictingSids: ['S-1-5-21-111-222-333-1002'], integrityRid: 0x1000,
  appContainerCapabilitiesReviewed: false, appContainerLoopbackExemption: false,
  rootAndDescendantsInJob: true, jobKillOnCloseProven: true,
  childTokenMatchesRoot: true, unexpectedInheritableHandleCount: 0,
  outsideTaskRead: 'DENIED', outsideTaskWrite: 'DENIED', protectedSecretRead: 'DENIED',
  dnsEgress: 'DENIED', directIpTcpEgress: 'DENIED', udpEgress: 'DENIED',
  loopbackEgress: 'DENIED', processDupHandleFromLowUser: 'DENIED',
  protectedTargetKind: 'installed-signed-guardian',
  revokedLaunch: 'DENIED', lostAckResolution: 'UNKNOWN_NO_REPLAY',
});

function expectBlocked(
  request: RestrictedWorkerProposal,
  witness: WindowsPhysicalWitnessClaims | undefined,
  code: RestrictedWorkerFinding,
): void {
  const review = reviewWindowsRestrictedWorkerPreflight(request, witness);
  assert.equal(review.decision, 'BLOCKED');
  assert.equal(review.runtimeDispatchAuthorized, false);
  assert.ok(review.findings.includes(code), 'missing gate: '+code);
  assert.ok(review.findings.includes('INDEPENDENT_OS_PROVIDER_NOT_ATTESTED'));
  assert.equal(review.claimsCompleteForIndependentReview, false);
}

test('no evidence and claimed-perfect evidence both refuse runtime dispatch', () => {
  expectBlocked(proposal(), undefined, 'PHYSICAL_CLAIMS_NOT_SUPPLIED');
  const result = reviewWindowsRestrictedWorkerPreflight(proposal(), claims());
  assert.equal(result.claimsCompleteForIndependentReview, true);
  assert.equal(result.decision, 'BLOCKED');
  assert.equal(result.runtimeDispatchAuthorized, false);
  assert.deepEqual(result.findings, ['INDEPENDENT_OS_PROVIDER_NOT_ATTESTED']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.findings), true);
});

test('existing NWJOB3/Job-only path cannot substitute for low-token launch', () => {
  expectBlocked({...proposal(), isolationMode: 'job-only', launchPath: 'windows-job-owner'},
    claims(), 'TOKEN_PROVIDER_UNAVAILABLE');
  expectBlocked({...proposal(), launchPath: 'node-spawn', fallbackToAmbientSpawn: true},
    claims(), 'AMBIENT_LAUNCH_FALLBACK');
});

test('current ambient environment, inherited handles and unrestricted network fail', () => {
  const r = reviewWindowsRestrictedWorkerPreflight({...proposal(),
    environment: 'ambient-process-env', handleInheritance: 'inherit-all',
    requestedNetworkPolicy: 'unspecified'}, claims());
  for(const code of ['AMBIENT_ENVIRONMENT','HANDLE_INHERITANCE_UNSAFE',
    'NETWORK_POLICY_NOT_DENY_ALL'] as RestrictedWorkerFinding[]) {
    assert.ok(r.findings.includes(code), code);
  }
  assert.equal(r.runtimeDispatchAuthorized, false);
});

test('grant identity, source SHA, revoked/expired/stale epochs are independently rejected', () => {
  expectBlocked({...proposal(), taskId: ''}, claims(), 'TASK_GRANT_IDENTITY_INVALID');
  expectBlocked({...proposal(), sourceSha: 'not-a-sha'}, claims(), 'TASK_GRANT_SHA_INVALID');
  expectBlocked({...proposal(), ownerEpoch: 0}, claims(), 'TASK_GRANT_EPOCH_INVALID');
  expectBlocked({...proposal(), observedOwnerEpoch: 3}, claims(), 'TASK_GRANT_NOT_CURRENT');
  expectBlocked({...proposal(), grantState: 'REVOKED'}, claims(), 'TASK_GRANT_EXPIRED_OR_REVOKED');
  expectBlocked({...proposal(), observedAtMs: 2_000}, claims(), 'TASK_GRANT_EXPIRED_OR_REVOKED');
  expectBlocked({...proposal(), targetPlatform: 'linux'}, claims(), 'TARGET_NOT_WINDOWS');
});

test('cloned request, mismatched owner epoch and recycled process identity reject claims', () => {
  expectBlocked(proposal(), {...claims(), requestId: 'cloned-runbook-request'},
    'PHYSICAL_CLAIM_BINDING_MISMATCH');
  expectBlocked(proposal(), {...claims(), ownerEpoch: 1},
    'PHYSICAL_CLAIM_BINDING_MISMATCH');
  expectBlocked(proposal(), {...claims(), rootPid: 0}, 'PROCESS_IDENTITY_UNPROVEN');
  expectBlocked(proposal(), {...claims(), guardianPid: 5551}, 'PROCESS_IDENTITY_UNPROVEN');
  expectBlocked(proposal(), {...claims(), rootCreationFiletime: '0'},
    'PROCESS_IDENTITY_UNPROVEN');
});

test('medium integrity, unrestricted token, or child token drift fail', () => {
  expectBlocked(proposal(), {...claims(), integrityRid: 0x2000}, 'LOW_INTEGRITY_UNPROVEN');
  expectBlocked(proposal(), {...claims(), restrictingSids: []}, 'RESTRICTED_TOKEN_UNPROVEN');
  expectBlocked(proposal(), {...claims(), childTokenMatchesRoot: false},
    'JOB_TREE_LIFETIME_UNPROVEN');
});

test('AppContainer demands SID, reviewed capabilities and no loopback exemption', () => {
  const req = {...proposal(), isolationMode: 'appcontainer' as const};
  expectBlocked(req, claims(), 'APPCONTAINER_UNPROVEN');
  expectBlocked(req, {...claims(), appContainerSid: 'S-1-15-2-123',
    appContainerCapabilitiesReviewed: true, appContainerLoopbackExemption: true},
    'APPCONTAINER_UNPROVEN');
  const reviewed = reviewWindowsRestrictedWorkerPreflight(req, {...claims(),
    appContainerSid: 'S-1-15-2-123', appContainerCapabilitiesReviewed: true});
  assert.equal(reviewed.claimsCompleteForIndependentReview, true);
  assert.equal(reviewed.runtimeDispatchAuthorized, false);
});

test('Job tree membership or lifecycle alone does not prove handle restrictions', () => {
  expectBlocked(proposal(), {...claims(), rootAndDescendantsInJob: false},
    'JOB_TREE_LIFETIME_UNPROVEN');
  expectBlocked(proposal(), {...claims(), unexpectedInheritableHandleCount: 1},
    'PRIVILEGED_HANDLE_INHERITANCE_UNPROVEN');
  expectBlocked(proposal(), {...claims(), outsideTaskRead: 'ALLOWED'},
    'FILESYSTEM_DENIAL_UNPROVEN');
});

test('DNS, TCP, UDP and loopback are separate deny gates', () => {
  for(const field of ['dnsEgress','directIpTcpEgress','udpEgress','loopbackEgress'] as const) {
    expectBlocked(proposal(), {...claims(), [field]: 'NOT_RUN'},
      'NETWORK_DENIAL_UNPROVEN');
  }
});

test('a synthetic same-user guardian cannot prove protected PROCESS_DUP_HANDLE denial', () => {
  expectBlocked(proposal(), {...claims(), protectedTargetKind: 'synthetic-temp'},
    'PROTECTED_PROCESS_DUP_HANDLE_UNPROVEN');
  expectBlocked(proposal(), {...claims(), processDupHandleFromLowUser: 'ALLOWED'},
    'PROTECTED_PROCESS_DUP_HANDLE_UNPROVEN');
});

test('revoke or lost-ACK replay cannot be recast as successful safe stop', () => {
  expectBlocked(proposal(), {...claims(), revokedLaunch: 'ALLOWED'},
    'REVOCATION_OR_UNKNOWN_REPLAY_UNSAFE');
  expectBlocked(proposal(), {...claims(), lostAckResolution: 'RELAUNCHED'},
    'REVOCATION_OR_UNKNOWN_REPLAY_UNSAFE');
});
