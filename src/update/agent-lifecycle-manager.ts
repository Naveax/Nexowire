/**
 * Isolated S3 lifecycle acceptance engine. No production adapter is wired to
 * this module: tests supply fake process, filesystem, signature and health
 * probes. Never treat a staged release or a PID as a healthy upgraded Agent.
 */
import { createHash, verify as verifySignature } from 'node:crypto';

export type BrokerMode = 'off' | 'auto' | 'on';
export interface AgentRuntime {
  ownerAccountId: string;
  deviceId: string;
  agentVersion: string;
  hubVersion: string;
  brokerMode: BrokerMode;
  coreGrantId: string | null;
  privilegeMode: 'safe' | 'full' | 'root' | 'core';
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
}
/** This is an independent trusted binary verifier, not a value from the manifest. */
export type InspectPublisher = (artifact: Buffer) => Promise<PublisherInspection>;
export interface ReleaseTrust {
  trustedManifestPublicKeyPem: string;
  trustedPublisher: string;
  inspectPublisher: InspectPublisher;
}
export interface UpgradeContext {
  expectedOwnerAccountId: string;
  expectedDeviceId: string;
  minimumFreeBytes: number;
  availableBytes: number;
  userApprovedDisruption: boolean;
}
export interface UpgradeAdapter {
  readRuntime(deviceId: string): Promise<AgentRuntime>;
  acquireDeviceLock(deviceId: string): Promise<() => Promise<void>>;
  stage(release: SignedRelease, deviceId: string): Promise<void>;
  stopOwnedAgent(deviceId: string): Promise<void>;
  cutover(deviceId: string, version: string): Promise<void>;
  startOwnedAgent(deviceId: string): Promise<void>;
  healthyRuntime(deviceId: string): Promise<AgentRuntime | null>;
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
  return value.split('.').map(Number);
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
  if (!trust.trustedManifestPublicKeyPem?.trim() ||
      !trust.trustedPublisher?.trim() ||
      !trust.inspectPublisher) fail('TRUST_ANCHOR_MISSING');
  if (!b64.test(release.manifestSignature) ||
      Buffer.from(release.manifestSignature, 'base64').toString('base64') !== release.manifestSignature) {
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
  const independent = await trust.inspectPublisher(release.artifact);
  if (!independent.signatureValid || independent.publisher !== trust.trustedPublisher ||
      independent.artifactSha256 !== actualHash) fail('BINARY_SIGNATURE_UNTRUSTED');
}
function sameAuthority(before: AgentRuntime, after: AgentRuntime): boolean {
  return before.ownerAccountId === after.ownerAccountId &&
    before.deviceId === after.deviceId &&
    before.brokerMode === after.brokerMode &&
    before.coreGrantId === after.coreGrantId &&
    before.privilegeMode === after.privilegeMode;
}
export async function preflightAgentUpgrade(
  release: SignedRelease, trust: ReleaseTrust, context: UpgradeContext,
  observed: AgentRuntime,
): Promise<void> {
  assertIdentity(context.expectedOwnerAccountId, 'OWNER');
  assertIdentity(context.expectedDeviceId, 'DEVICE');
  if (!sameAuthority({ ...observed, ownerAccountId: context.expectedOwnerAccountId,
    deviceId: context.expectedDeviceId }, observed)) fail('DEVICE_OR_OWNER_MISMATCH');
  if (context.userApprovedDisruption !== true) fail('EXPLICIT_APPROVAL_REQUIRED');
  if (!Number.isSafeInteger(context.minimumFreeBytes) || context.minimumFreeBytes <= 0 ||
      !Number.isSafeInteger(context.availableBytes) ||
      context.availableBytes < context.minimumFreeBytes) fail('INSUFFICIENT_DISK_SPACE');
  await verifyAgentRelease(release, trust);
  if (inspectAgentHubCompatibility(release.manifest, observed) !== 'compatible') fail('VERSION_INCOMPATIBLE');
  if (compare(release.manifest.version, observed.agentVersion) <= 0) fail('REPLAY_OR_DOWNGRADE');
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
    await adapter.stage(release, context.expectedDeviceId);
    // Do not trust a long-running preflight across a blocking stage operation.
    const fresh = await adapter.readRuntime(context.expectedDeviceId);
    if (!sameAuthority(before, fresh) || fresh.agentVersion !== before.agentVersion ||
        fresh.hubVersion !== before.hubVersion) fail('PREFLIGHT_STALE');
    potentiallyStopped = true;
    await adapter.stopOwnedAgent(context.expectedDeviceId);
    await adapter.cutover(context.expectedDeviceId, release.manifest.version);
    await adapter.startOwnedAgent(context.expectedDeviceId);
    const after = await adapter.healthyRuntime(context.expectedDeviceId);
    if (!after || !sameAuthority(before, after) ||
        after.agentVersion !== release.manifest.version ||
        after.hubVersion !== before.hubVersion) fail('POST_UPDATE_HEALTH_UNCONFIRMED');
    return { status: 'succeeded', deviceId: before.deviceId,
      fromVersion: before.agentVersion, toVersion: after.agentVersion };
  } catch (error) {
    if (!potentiallyStopped || !before) throw error;
    const cause = error instanceof Error ? error.message : 'S3_UNKNOWN_FAILURE';
    try {
      await adapter.stopOwnedAgent(before.deviceId);
      await adapter.cutover(before.deviceId, before.agentVersion);
      await adapter.startOwnedAgent(before.deviceId);
      const restored = await adapter.healthyRuntime(before.deviceId);
      if (restored && sameAuthority(before, restored) &&
          restored.agentVersion === before.agentVersion &&
          restored.hubVersion === before.hubVersion) {
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
