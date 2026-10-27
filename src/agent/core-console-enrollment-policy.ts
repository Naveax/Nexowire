import {createHash, createPublicKey, verify} from 'node:crypto';

/**
 * CORE is an indefinite OWNER PREFERENCE, not an ambient Windows input grant.
 * This is an offline certificate/epoch verifier for an eventual locally enrolled
 * console profile. It never writes a device grant or authorizes native dispatch.
 */
export interface CoreConsoleEnrollmentV1 {
  readonly version: 1;
  readonly scope: 'physical-console';
  readonly ownerAccountId: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly enrollmentId: string;
  readonly ownerEpoch: number;
  readonly grantGeneration: number;
  readonly revokeEpoch: number;
  readonly approvedLocallyAtMs: number;
  readonly issuerSpkiSha256: string;
}
export interface SignedCoreConsoleEnrollmentV1 {
  readonly enrollment: CoreConsoleEnrollmentV1;
  readonly signatureBase64: string;
}
/**
 * Must originate from an independently authenticated CURRENT owner/revoke
 * authority, never raw UI, local preference, OAuth cookie, or Agent telemetry.
 */
export interface CoreConsoleCurrentReadback {
  readonly ownerAccountId: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly ownerEpoch: number;
  readonly grantGeneration: number;
  readonly revokeEpoch: number;
  readonly coreEnabled: boolean;
  readonly accessMode: 'safe' | 'full';
  readonly deviceOnline: boolean;
  readonly bridgeVerified: boolean;
}
export interface CoreConsoleEvaluation {
  readonly duration: 'indefinite-revocable';
  readonly expiresAt: null;
  readonly policyEligible: boolean;
  readonly mayDispatch: false;
  readonly reason: 'ELIGIBLE_NEEDS_NATIVE_ADMISSION' |
    'LOCAL_ENROLLMENT_REQUIRED' | 'INVALID_ENROLLMENT' |
    'STALE_OR_REVOKED' | 'OWNER_DEVICE_MISMATCH' |
    'CORE_NOT_EFFECTIVE' | 'PHYSICAL_DESKTOP_NOT_ALLOWED';
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{7,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const keyNames = [
  'version','scope','ownerAccountId','deviceId','installationId',
  'enrollmentId','ownerEpoch','grantGeneration','revokeEpoch',
  'approvedLocallyAtMs','issuerSpkiSha256',
];
function exact(value: unknown, keys: readonly string[]): value is Record<string,unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every(key => keys.includes(key));
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function valid(input: unknown): input is CoreConsoleEnrollmentV1 {
  if (!exact(input,keyNames)) return false;
  return input.version === 1 && input.scope === 'physical-console' &&
    [input.ownerAccountId,input.deviceId,input.installationId,input.enrollmentId]
      .every(value => typeof value === 'string' && ID.test(value)) &&
    integer(input.ownerEpoch) && input.ownerEpoch > 0 &&
    integer(input.grantGeneration) && input.grantGeneration > 0 &&
    integer(input.revokeEpoch) && integer(input.approvedLocallyAtMs) &&
    input.approvedLocallyAtMs > 0 &&
    typeof input.issuerSpkiSha256 === 'string' && HEX64.test(input.issuerSpkiSha256);
}
function validReadback(input: unknown): input is CoreConsoleCurrentReadback {
  if (!exact(input, [
    'ownerAccountId','deviceId','installationId','ownerEpoch',
    'grantGeneration','revokeEpoch','coreEnabled','accessMode',
    'deviceOnline','bridgeVerified',
  ])) return false;
  return [input.ownerAccountId,input.deviceId,input.installationId]
    .every(value => typeof value === 'string' && ID.test(value)) &&
    integer(input.ownerEpoch) && input.ownerEpoch > 0 &&
    integer(input.grantGeneration) && input.grantGeneration > 0 &&
    integer(input.revokeEpoch) && typeof input.coreEnabled === 'boolean' &&
    (input.accessMode === 'safe' || input.accessMode === 'full') &&
    typeof input.deviceOnline === 'boolean' &&
    typeof input.bridgeVerified === 'boolean';
}
/** Canonical signed payload: untrusted unknown keys cannot be silently ignored. */
export function canonicalCoreConsoleEnrollment(value: CoreConsoleEnrollmentV1): Buffer {
  if (!valid(value)) throw new Error('CORE_CONSOLE_ENROLLMENT_INVALID');
  return Buffer.from(JSON.stringify(keyNames.map(k =>
    (value as unknown as Record<string,unknown>)[k])),'utf8');
}
function blocked(reason: CoreConsoleEvaluation['reason']): CoreConsoleEvaluation {
  return {duration:'indefinite-revocable',expiresAt:null,
    policyEligible:false,mayDispatch:false,reason};
}
/**
 * The signer key MUST be pinned on the installed device by an independently
 * authenticated local provisioning step; it must never come from the caller
 * payload. The readback likewise must come from an external, authenticated,
 * monotonic authority rather than the same restorable local JSON state.
 */
export function evaluateCoreConsoleEnrollment(input: {
  readonly certificate: SignedCoreConsoleEnrollmentV1 | null;
  readonly pinnedLocalSpkiDer: Uint8Array | null;
  readonly trustedCurrentReadback: CoreConsoleCurrentReadback | null;
  readonly requestedOwnerAccountId: string;
  readonly requestedDeviceId: string;
  readonly requestedInstallationId: string;
  readonly nowMs: number;
  readonly desktop: 'default' | 'private' | 'secure' | 'locked' | 'unknown';
}): CoreConsoleEvaluation {
  const certificate = input.certificate;
  const enrollment = certificate?.enrollment;
  if (!certificate || !input.pinnedLocalSpkiDer || !input.trustedCurrentReadback)
    return blocked('LOCAL_ENROLLMENT_REQUIRED');
  if (!exact(certificate,['enrollment','signatureBase64']) ||
      !valid(enrollment) || !validReadback(input.trustedCurrentReadback) ||
      !Number.isSafeInteger(input.nowMs) || input.nowMs <= 0 ||
      enrollment.approvedLocallyAtMs > input.nowMs)
    return blocked('INVALID_ENROLLMENT');
  const proof = input.trustedCurrentReadback;
  if (enrollment.ownerAccountId !== input.requestedOwnerAccountId ||
      enrollment.deviceId !== input.requestedDeviceId ||
      enrollment.installationId !== input.requestedInstallationId ||
      proof.ownerAccountId !== input.requestedOwnerAccountId ||
      proof.deviceId !== input.requestedDeviceId ||
      proof.installationId !== input.requestedInstallationId)
    return blocked('OWNER_DEVICE_MISMATCH');
  if (!integer(proof.ownerEpoch) || !integer(proof.grantGeneration) ||
      !integer(proof.revokeEpoch) || proof.ownerEpoch !== enrollment.ownerEpoch ||
      proof.grantGeneration !== enrollment.grantGeneration ||
      proof.revokeEpoch !== enrollment.revokeEpoch)
    return blocked('STALE_OR_REVOKED');
  if (!proof.coreEnabled || proof.accessMode !== 'full' ||
      !proof.deviceOnline || !proof.bridgeVerified)
    return blocked('CORE_NOT_EFFECTIVE');
  if (input.desktop !== 'default')
    return blocked('PHYSICAL_DESKTOP_NOT_ALLOWED');
  try {
    if (!(input.pinnedLocalSpkiDer instanceof Uint8Array) ||
        input.pinnedLocalSpkiDer.byteLength > 256 ||
        typeof certificate.signatureBase64 !== 'string' ||
        certificate.signatureBase64.length !== 88)
      return blocked('INVALID_ENROLLMENT');
    const pinned = Buffer.from(input.pinnedLocalSpkiDer);
    if (createHash('sha256').update(pinned).digest('hex') !== enrollment.issuerSpkiSha256)
      return blocked('INVALID_ENROLLMENT');
    const signature = Buffer.from(certificate.signatureBase64,'base64');
    const key = createPublicKey({key:pinned,format:'der',type:'spki'});
    if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 ||
        signature.toString('base64') !== certificate.signatureBase64 ||
        !verify(null,canonicalCoreConsoleEnrollment(enrollment),
          key,signature))
      return blocked('INVALID_ENROLLMENT');
  } catch {
    return blocked('INVALID_ENROLLMENT');
  }
  // This is policy eligibility ONLY. A separate native console admission
  // must recheck HWND/PID, current grant, owner revocation and platform policy.
  return {duration:'indefinite-revocable',expiresAt:null,
    policyEligible:true,mayDispatch:false,reason:'ELIGIBLE_NEEDS_NATIVE_ADMISSION'};
}
