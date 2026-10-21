/**
 * Isolated S3 lifecycle acceptance engine. No production adapter is wired to
 * this module: tests supply fake process, filesystem, signature and health
 * probes. Never treat a staged release or a PID as a healthy upgraded Agent.
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

export type BrokerMode = 'off' | 'auto' | 'on';
export interface AgentRuntime {
  ownerAccountId: string;
  deviceId: string;
  agentVersion: string;
  hubVersion: string;
  brokerMode: BrokerMode;
  coreGrantId: string | null;
  privilegeMode: 'safe' | 'full' | 'root' | 'core';
  /** Attested authenticated session epoch; not a bearer token or timestamp. */
  authSessionEpoch: string;
  /** Must come from owner authority, not a worker flag. */
  authTokenValid: boolean;
}
export interface SignedAgentManifest {
  schemaVersion: 1;
  version: string;
  sourceSha: string;
  artifactSha256: string;
  publisher: string;
  minAgentVersion: string;
  maxAgentVersion: string;
  minHubVersion: string;
  maxHubVersion: string;
}
export interface SignedRelease {
  manifest: SignedAgentManifest;
  manifestSignature: string;
  artifact: Buffer;
}
export interface PublisherInspection {
  signatureValid: boolean;
  publisher: string;
  artifactSha256: string;
  certificateSha256: string;
}
/** This is an independent trusted binary verifier, not a value from the manifest. */
export type InspectPublisher = (artifact: Buffer) => Promise<PublisherInspection>;
export interface ReleaseTrust {
  trustedManifestPublicKeyPem: string;
  trustedPublisher: string;
  /** DER SHA-256 of the trusted first-party Authenticode signing certificate. */
  trustedCertificateSha256: string;
  inspectPublisher: InspectPublisher;
}
export interface UpgradeContext {
  expectedOwnerAccountId: string;
  expectedDeviceId: string;
  minimumFreeBytes: number;
  availableBytes: number;
  userApprovedDisruption: boolean;
  /** Signed, retained OLD binary, not a version string or downloadable URL. */
  rollbackRelease: SignedRelease;
}
/** Supplied by a trusted native OS attestor, never worker stdout or a TCP port probe. */
export interface AgentBinaryEvidence {
  installedArtifactSha256: string;
  runningImageSha256: string;
  processCreationIdentity: string;
  healthAuthenticated: boolean;
}
export interface UpgradeAdapter {
  readRuntime(deviceId: string): Promise<AgentRuntime>;
  acquireDeviceLock(deviceId: string): Promise<() => Promise<void>>;
  stage(release: SignedRelease, deviceId: string): Promise<void>;
  /** Independent readback from a protected, non-reparse staging slot. */
  readStagedBytes(deviceId: string, slot: 'target' | 'rollback'): Promise<Buffer>;
  stageRollback(release: SignedRelease, deviceId: string): Promise<void>;
  stopOwnedAgent(deviceId: string): Promise<void>;
  /** Implementation MUST atomically pin exactly these validated bytes. */
  cutover(deviceId: string, version: string, expectedSha256: string): Promise<void>;
  startOwnedAgent(deviceId: string): Promise<void>;
  healthyRuntime(deviceId: string): Promise<AgentRuntime | null>;
  /** Must bind actual process image, creation identity, installed bytes and authenticated health. */
  attestOwnedAgentBinary(deviceId: string): Promise<AgentBinaryEvidence | null>;
}
export type UpgradeResult =
  | { status: 'succeeded'; deviceId: string; fromVersion: string; toVersion: string }
  | { status: 'rolled_back'; deviceId: string; fromVersion: string; error: string }
  | { status: 'rollback_unconfirmed'; deviceId: string; fromVersion: string; error: string };

const hex40 = /^[a-f0-9]{40}$/;
const hex64 = /^[a-f0-9]{64}$/;
const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const manifestKeys: (keyof SignedAgentManifest)[] = [
  'schemaVersion', 'version', 'sourceSha', 'artifactSha256',
  'publisher', 'minAgentVersion', 'maxAgentVersion',
  'minHubVersion', 'maxHubVersion',
];

function fail(code: string): never { throw new Error('S3_' + code); }
function assertIdentity(value: string, kind: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(value)) fail(kind + '_INVALID');
}
function version(value: string): number[] {
  if (!versionPattern.test(value)) fail('VERSION_INVALID');
  const parts = value.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) fail('VERSION_INVALID');
  return parts;
}
function compare(a: string, b: string): number {
  const l = version(a);
  const r = version(b);
  for (let i = 0; i < 3; i++) {
    if (l[i]! < r[i]!) return -1;
    if (l[i]! > r[i]!) return 1;
  }
  return 0;
}
function within(actual: string, minimum: string, maximum: string): boolean {
  return compare(actual, minimum) >= 0 && compare(actual, maximum) <= 0;
}
export function inspectAgentHubCompatibility(
  manifest: SignedAgentManifest,
  runtime: AgentRuntime,
): 'compatible' | 'agent_unsupported' | 'hub_unsupported' {
  if (!within(runtime.agentVersion, manifest.minAgentVersion, manifest.maxAgentVersion)) return 'agent_unsupported';
  if (!within(runtime.hubVersion, manifest.minHubVersion, manifest.maxHubVersion)) return 'hub_unsupported';
  return 'compatible';
}
export function canonicalAgentManifest(manifest: SignedAgentManifest): Buffer {
  if (!manifest || typeof manifest !== 'object' ||
      Object.keys(manifest).sort().join(',') !== [...manifestKeys].sort().join(',')) {
    fail('MANIFEST_FIELDS_INVALID');
  }
  if (manifest.schemaVersion !== 1 || !hex40.test(manifest.sourceSha) ||
      !hex64.test(manifest.artifactSha256) ||
      !/^[A-Za-z0-9 &,.-]{3,128}$/.test(manifest.publisher)) fail('MANIFEST_INVALID');
  for (const key of [
    'version', 'minAgentVersion', 'maxAgentVersion',
    'minHubVersion', 'maxHubVersion',
  ] as const) version(manifest[key]);
  if (compare(manifest.minAgentVersion, manifest.maxAgentVersion) > 0 ||
      compare(manifest.minHubVersion, manifest.maxHubVersion) > 0) fail('MANIFEST_RANGE_INVALID');
  return Buffer.from(JSON.stringify(Object.fromEntries(manifestKeys.map(k => [k, manifest[k]]))), 'utf8');
}
export async function verifyAgentRelease(
  release: SignedRelease,
  trust: ReleaseTrust,
): Promise<void> {
  const bytes = canonicalAgentManifest(release.manifest);
  if (!trust?.trustedManifestPublicKeyPem?.trim() ||
      !trust.trustedPublisher?.trim() ||
      !hex64.test(trust.trustedCertificateSha256) ||
      typeof trust.inspectPublisher !== 'function') fail('TRUST_ANCHOR_MISSING');
  try {
    if (createPublicKey(trust.trustedManifestPublicKeyPem).asymmetricKeyType !== 'ed25519') {
      fail('MANIFEST_KEY_TYPE_INVALID');
    }
  } catch { fail('MANIFEST_KEY_TYPE_INVALID'); }
  if (!b64.test(release.manifestSignature) ||
      Buffer.from(release.manifestSignature, 'base64').toString('base64') !== release.manifestSignature) {
    fail('MANIFEST_SIGNATURE_ENCODING_INVALID');
  }
  if (Buffer.from(release.manifestSignature, 'base64').length !== 64) {
    fail('MANIFEST_SIGNATURE_ENCODING_INVALID');
  }
  let verified = false;
  try {
    verified = verifySignature(null, bytes, trust.trustedManifestPublicKeyPem,
      Buffer.from(release.manifestSignature, 'base64'));
  } catch { fail('MANIFEST_SIGNATURE_INVALID'); }
  if (!verified) fail('MANIFEST_SIGNATURE_INVALID');
  const actualHash = createHash('sha256').update(release.artifact).digest('hex');
  if (actualHash !== release.manifest.artifactSha256) fail('ARTIFACT_HASH_MISMATCH');
  if (release.manifest.publisher !== trust.trustedPublisher) fail('PUBLISHER_MISMATCH');
  let independent: PublisherInspection;
  try {
    independent = await trust.inspectPublisher(release.artifact);
  } catch { fail('BINARY_SIGNATURE_UNTRUSTED'); }
  if (!independent?.signatureValid || independent.publisher !== trust.trustedPublisher ||
      independent.artifactSha256 !== actualHash ||
      independent.certificateSha256 !== trust.trustedCertificateSha256) {
    fail('BINARY_SIGNATURE_UNTRUSTED');
  }
}
function sameAuthority(before: AgentRuntime, after: AgentRuntime): boolean {
  return before.ownerAccountId === after.ownerAccountId &&
    before.deviceId === after.deviceId &&
    before.brokerMode === after.brokerMode &&
    before.coreGrantId === after.coreGrantId &&
    before.privilegeMode === after.privilegeMode &&
    before.authSessionEpoch === after.authSessionEpoch &&
    before.authTokenValid === true && after.authTokenValid === true;
}
export async function preflightAgentUpgrade(
  release: SignedRelease, trust: ReleaseTrust, context: UpgradeContext,
  observed: AgentRuntime,
): Promise<void> {
  assertIdentity(context.expectedOwnerAccountId, 'OWNER');
  assertIdentity(observed.authSessionEpoch, 'AUTH_SESSION_EPOCH');
  if (observed.authTokenValid !== true) fail('TOKEN_REVOKED');
  assertIdentity(context.expectedDeviceId, 'DEVICE');
  if (!sameAuthority({ ...observed, ownerAccountId: context.expectedOwnerAccountId,
    deviceId: context.expectedDeviceId }, observed)) fail('DEVICE_OR_OWNER_MISMATCH');
  if (context.userApprovedDisruption !== true) fail('EXPLICIT_APPROVAL_REQUIRED');
  if (!Number.isSafeInteger(context.minimumFreeBytes) || context.minimumFreeBytes <= 0 ||
      !Number.isSafeInteger(context.availableBytes) ||
      context.availableBytes < context.minimumFreeBytes) fail('INSUFFICIENT_DISK_SPACE');
  await verifyAgentRelease(release, trust);
  if (!context.rollbackRelease?.manifest ||
      context.rollbackRelease.manifest.version !== observed.agentVersion) {
    fail('SIGNED_ROLLBACK_ARTIFACT_REQUIRED');
  }
  await verifyAgentRelease(context.rollbackRelease, trust);
  if (inspectAgentHubCompatibility(context.rollbackRelease.manifest, observed) !== 'compatible') {
    fail('ROLLBACK_VERSION_INCOMPATIBLE');
  }
  if (context.rollbackRelease.manifest.artifactSha256 === release.manifest.artifactSha256) {
    fail('ROLLBACK_IDENTICAL_TO_TARGET');
  }
  if (inspectAgentHubCompatibility(release.manifest, observed) !== 'compatible') fail('VERSION_INCOMPATIBLE');
  if (compare(release.manifest.version, observed.agentVersion) <= 0) fail('REPLAY_OR_DOWNGRADE');
}
/** Rehash the actually staged bytes, not a publisher supplied hash or an EXE path. */
function verifiedBinaryEvidence(
  evidence: AgentBinaryEvidence | null, expectedSha256: string,
): boolean {
  return !!evidence && evidence.healthAuthenticated === true &&
    evidence.installedArtifactSha256 === expectedSha256 &&
    evidence.runningImageSha256 === expectedSha256 &&
    typeof evidence.processCreationIdentity === 'string' &&
    /^[A-Za-z0-9_.:@-]{16,128}$/.test(evidence.processCreationIdentity);
}
async function checkStagedHash(
  adapter: UpgradeAdapter, deviceId: string, slot: 'target' | 'rollback',
  release: SignedRelease,
): Promise<void> {
  const bytes = await adapter.readStagedBytes(deviceId, slot);
  if (!Buffer.isBuffer(bytes) || bytes.length !== release.artifact.length ||
      createHash('sha256').update(bytes).digest('hex') !== release.manifest.artifactSha256) {
    fail('STAGED_' + slot.toUpperCase() + '_HASH_MISMATCH');
  }
}
/**
 * Device-scoped, two-phase update. Adapter methods MUST themselves enforce
 * process ownership, atomic launcher replace, and exclusive update locks.
 * On any ambiguous post-stop failure, report unknown rather than success.
 */
export async function upgradeIsolatedAgent(
  release: SignedRelease, trust: ReleaseTrust, context: UpgradeContext,
  adapter: UpgradeAdapter,
): Promise<UpgradeResult> {
  const releaseLock = await adapter.acquireDeviceLock(context.expectedDeviceId);
  let before: AgentRuntime | undefined;
  let potentiallyStopped = false;
  try {
    before = await adapter.readRuntime(context.expectedDeviceId);
    await preflightAgentUpgrade(release, trust, context, before);
    // Preserve signed OLD bytes before preparing any destructive cutover.
    await adapter.stageRollback(context.rollbackRelease, context.expectedDeviceId);
    await checkStagedHash(adapter, before.deviceId, 'rollback', context.rollbackRelease);
    await adapter.stage(release, context.expectedDeviceId);
    await checkStagedHash(adapter, before.deviceId, 'target', release);
    // Do not trust a long-running preflight across a blocking stage operation.
    const fresh = await adapter.readRuntime(context.expectedDeviceId);
    if (!sameAuthority(before, fresh) || fresh.agentVersion !== before.agentVersion ||
        fresh.hubVersion !== before.hubVersion) fail('PREFLIGHT_STALE');
    // Recheck both protected slots as close to disruption as possible.
    await checkStagedHash(adapter, before.deviceId, 'rollback', context.rollbackRelease);
    await checkStagedHash(adapter, before.deviceId, 'target', release);
    potentiallyStopped = true;
    await adapter.stopOwnedAgent(context.expectedDeviceId);
    await adapter.cutover(context.expectedDeviceId, release.manifest.version,
      release.manifest.artifactSha256);
    await adapter.startOwnedAgent(context.expectedDeviceId);
    const after = await adapter.healthyRuntime(context.expectedDeviceId);
    if (!after || !sameAuthority(before, after) ||
        after.agentVersion !== release.manifest.version ||
        after.hubVersion !== before.hubVersion ||
        !verifiedBinaryEvidence(await adapter.attestOwnedAgentBinary(before.deviceId),
          release.manifest.artifactSha256)) fail('POST_UPDATE_HEALTH_UNCONFIRMED');
    return { status: 'succeeded', deviceId: before.deviceId,
      fromVersion: before.agentVersion, toVersion: after.agentVersion };
  } catch (error) {
    if (!potentiallyStopped || !before) throw error;
    const cause = error instanceof Error ? error.message : 'S3_UNKNOWN_FAILURE';
    try {
      // If the old binary changed, do not launch a hash-unknown rollback EXE.
      await checkStagedHash(adapter, before.deviceId, 'rollback', context.rollbackRelease);
      await adapter.stopOwnedAgent(before.deviceId);
      await adapter.cutover(before.deviceId, before.agentVersion,
        context.rollbackRelease.manifest.artifactSha256);
      await adapter.startOwnedAgent(before.deviceId);
      const restored = await adapter.healthyRuntime(before.deviceId);
      if (restored && sameAuthority(before, restored) &&
          restored.agentVersion === before.agentVersion &&
          restored.hubVersion === before.hubVersion &&
          verifiedBinaryEvidence(await adapter.attestOwnedAgentBinary(before.deviceId),
            context.rollbackRelease.manifest.artifactSha256)) {
        return { status: 'rolled_back', deviceId: before.deviceId,
          fromVersion: before.agentVersion, error: cause };
      }
    } catch { /* Verification below intentionally remains unknown. */ }
    return { status: 'rollback_unconfirmed', deviceId: before.deviceId,
      fromVersion: before.agentVersion, error: cause };
  } finally {
    await releaseLock();
  }
}
