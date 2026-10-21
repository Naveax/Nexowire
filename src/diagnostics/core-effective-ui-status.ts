import {verify, type KeyObject} from 'node:crypto';

/** UI-only projection. No returned value authorizes a Windows command. */
export type UiAccess = 'SAFE' | 'FULL' | 'ROOT' | 'CORE';
export type EffectiveUiState =
  | 'SAFE_USER' | 'FULL_STANDARD_USER' | 'ROOT_EXPIRED' | 'CORE_OFF'
  | 'PAUSED_UNVERIFIED' | 'ROOT_SIGNED_BROKER' | 'CORE_SIGNED_BROKER';
export type UiStatusReason =
  | 'DEVICE_OFFLINE' | 'FULL_REQUIRED' | 'OWNER_SESSION_MISSING'
  | 'BRIDGE_REQUESTED_OFF' | 'ROOT_LEASE_INVALID_OR_EXPIRED'
  | 'CORE_PREFERENCE_NOT_ENABLED' | 'CORE_REVOKED_OR_STALE_EPOCH'
  | 'BROKER_OR_WITNESS_PROOF_MISSING_OR_INVALID';

export interface CoreUiFacts {
  readonly deviceId: string;
  readonly ownerAccountId: string;
  readonly currentOwnerSessionId: string | null;
  readonly requestedMode: UiAccess;
  readonly accessMode: 'safe' | 'full';
  readonly online: boolean;
  readonly bridgeRequested: 'auto' | 'on' | 'off';
  readonly corePreferenceEnabled: boolean;
  readonly rootLease: {
    readonly ownerAccountId: string;
    readonly sessionId: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
  } | null;
  /** Untrusted UI/Agent signals: never accepted as Windows authority. */
  readonly reportedCoreActive?: boolean;
  readonly agentReportedBrokerReady?: boolean;
  readonly consentExeSeen?: boolean;
  readonly brokerHttpStatus?: number;
}

export interface BrokerNativeStatement {
  readonly schema: 'nexowire.ui.broker-native.v1';
  readonly deviceId: string;
  readonly ownerAccountId: string;
  readonly ownerSessionId: string;
  readonly ownerEpoch: number;
  readonly grantGeneration: number;
  readonly grantMode: 'ROOT' | 'CORE';
  readonly rootLeaseIssuedAt: string | null;
  readonly rootLeaseExpiresAt: string | null;
  readonly observedAt: string;
  readonly brokerImageSha256: string;
  readonly brokerVersion: string;
  readonly nativeHighToken: boolean;
  readonly administratorsEnabled: boolean;
  readonly authenticatedBroker: boolean;
  readonly pinnedPublisherSignature: boolean;
  readonly protectedParentAcl: boolean;
  readonly protectedImportTreeAcl: boolean;
  readonly protectedTaskIdentity: boolean;
  readonly locallyAttestedEnrollment: boolean;
}
export interface ExternalEpochWitness {
  readonly schema: 'nexowire.ui.external-epoch.v1';
  readonly deviceId: string;
  readonly ownerAccountId: string;
  readonly ownerEpoch: number;
  readonly grantGeneration: number;
  readonly revoked: boolean;
  readonly observedAt: string;
}
export interface SignedStatement<T> { readonly statement: T; readonly signature: string; }
export interface SignedUiEvidence {
  readonly broker: SignedStatement<BrokerNativeStatement>;
  readonly externalWitness: SignedStatement<ExternalEpochWitness>;
}
export interface CoreUiTrustPins {
  /** Must be pinned to a physically accepted protected Windows native collector. */
  readonly brokerNativeKey: KeyObject;
  /** Must be pinned to a separately trusted external monotonic CAS authority. */
  readonly externalWitnessKey: KeyObject;
  readonly expectedBrokerImageSha256: string;
  readonly expectedBrokerVersion: string;
  /** Read at projection time from independent monotonic authority, never browser JSON. */
  readonly expectedOwnerEpoch: number;
  readonly expectedGrantGeneration: number;
  /** The timestamp is supplied by a trusted clock, not the browser. */
  readonly now: Date;
}
export interface CoreUiStatus {
  readonly requestedMode: UiAccess;
  readonly state: EffectiveUiState;
  readonly effectiveElevatedBroker: boolean;
  readonly evidence: 'signed-native-and-external-epoch-candidate' | 'not-proven';
  readonly duration: '15-minute-max' | 'persistent-until-revoked' | 'standard-user';
  readonly label: string;
  readonly reasons: readonly UiStatusReason[];
  readonly grantsExecution: false;
  readonly uacApprovalProvenByUi: false;
}

const MAX_EVIDENCE_AGE_MS = 30_000;
const FUTURE_TOLERANCE_MS = 2_000;
const MAX_ROOT_LEASE_MS = 900_000;
const hex64 = /^[0-9a-f]{64}$/;
const encodedSignature = /^[A-Za-z0-9+/]{86}==$/;

/** Stable contract bytes, independent of object key insertion order. */
export function coreUiBrokerSigningBytes(s: BrokerNativeStatement): Buffer {
  return Buffer.from(JSON.stringify([
    s.schema,s.deviceId,s.ownerAccountId,s.ownerSessionId,s.ownerEpoch,
    s.grantGeneration,s.grantMode,s.rootLeaseIssuedAt,s.rootLeaseExpiresAt,
    s.observedAt,s.brokerImageSha256,s.brokerVersion,
    s.nativeHighToken,s.administratorsEnabled,s.authenticatedBroker,
    s.pinnedPublisherSignature,s.protectedParentAcl,s.protectedImportTreeAcl,
    s.protectedTaskIdentity,s.locallyAttestedEnrollment,
  ]),'utf8');
}
export function coreUiWitnessSigningBytes(s: ExternalEpochWitness): Buffer {
  return Buffer.from(JSON.stringify([
    s.schema,s.deviceId,s.ownerAccountId,s.ownerEpoch,s.grantGeneration,
    s.revoked,s.observedAt,
  ]),'utf8');
}
function fresh(value: string, now: number): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now + FUTURE_TOLERANCE_MS &&
    parsed >= now - MAX_EVIDENCE_AGE_MS;
}
function positiveEpoch(n: number): boolean {return Number.isSafeInteger(n) && n > 0;}
function verifyEd25519(key: KeyObject, data: Buffer, signature: string): boolean {
  return typeof signature === 'string' && encodedSignature.test(signature) &&
    verify(null, data, key, Buffer.from(signature, 'base64'));
}

/**
 * Cryptographic *source acceptance* only. Real protected-key custody, pinned
 * Authenticode chain and external CAS are physical integration gates.
 * In particular, a JSON boolean, consent.exe observation, port 43112 or 401
 * response never substitutes for both independently signed statements.
 */
function validateEvidence(
  facts: CoreUiFacts, pins: CoreUiTrustPins, signed: SignedUiEvidence | null,
): 'valid' | 'revoked' | 'invalid' {
  if (!signed) return 'invalid';
  try {
    const b = signed.broker.statement;
    const w = signed.externalWitness.statement;
    const now = pins.now.getTime();
    if (pins.brokerNativeKey.export({format:'der',type:'spki'}).equals(
          pins.externalWitnessKey.export({format:'der',type:'spki'}))) return 'invalid';
    if (!Number.isFinite(now) ||
        b.schema !== 'nexowire.ui.broker-native.v1' ||
        w.schema !== 'nexowire.ui.external-epoch.v1' ||
        !positiveEpoch(b.ownerEpoch) || !positiveEpoch(b.grantGeneration) ||
        !positiveEpoch(w.ownerEpoch) || !positiveEpoch(w.grantGeneration) ||
        !fresh(b.observedAt, now) || !fresh(w.observedAt, now) ||
        b.deviceId !== facts.deviceId || w.deviceId !== facts.deviceId ||
        b.ownerAccountId !== facts.ownerAccountId ||
        w.ownerAccountId !== facts.ownerAccountId ||
        b.ownerSessionId !== facts.currentOwnerSessionId ||
        b.ownerEpoch !== w.ownerEpoch ||
        b.grantGeneration !== w.grantGeneration ||
        b.ownerEpoch !== pins.expectedOwnerEpoch ||
        b.grantGeneration !== pins.expectedGrantGeneration ||
        b.grantMode !== facts.requestedMode ||
        (b.grantMode === 'CORE' && (b.rootLeaseIssuedAt !== null || b.rootLeaseExpiresAt !== null)) ||
        (b.grantMode === 'ROOT' && (!facts.rootLease ||
           b.rootLeaseIssuedAt !== facts.rootLease.issuedAt ||
           b.rootLeaseExpiresAt !== facts.rootLease.expiresAt)) ||
        !hex64.test(b.brokerImageSha256) ||
        b.brokerImageSha256 !== pins.expectedBrokerImageSha256 ||
        b.brokerVersion !== pins.expectedBrokerVersion ||
        !verifyEd25519(pins.brokerNativeKey, coreUiBrokerSigningBytes(b), signed.broker.signature) ||
        !verifyEd25519(pins.externalWitnessKey, coreUiWitnessSigningBytes(w), signed.externalWitness.signature)) {
      return 'invalid';
    }
    if (w.revoked === true) return 'revoked';
    if (w.revoked !== false ||
        b.nativeHighToken !== true || b.administratorsEnabled !== true ||
        b.authenticatedBroker !== true || b.pinnedPublisherSignature !== true ||
        b.protectedParentAcl !== true || b.protectedImportTreeAcl !== true ||
        b.protectedTaskIdentity !== true || b.locallyAttestedEnrollment !== true) return 'invalid';
    return 'valid';
  } catch { return 'invalid'; }
}

export function projectCoreEffectiveUiStatus(
  facts: CoreUiFacts, pins: CoreUiTrustPins, signed: SignedUiEvidence | null = null,
): CoreUiStatus {
  const mode = facts.requestedMode;
  const duration: CoreUiStatus['duration'] = mode === 'ROOT' ? '15-minute-max'
    : mode === 'CORE' ? 'persistent-until-revoked' : 'standard-user';
  const result = (
    state: EffectiveUiState, label: string, reasons: UiStatusReason[] = [],
    evidence: CoreUiStatus['evidence'] = 'not-proven',
  ): CoreUiStatus => ({requestedMode:mode,state,label,reasons,evidence,duration,
    effectiveElevatedBroker: state === 'ROOT_SIGNED_BROKER' || state === 'CORE_SIGNED_BROKER',
    grantsExecution:false,uacApprovalProvenByUi:false});
  if (mode === 'SAFE') return result('SAFE_USER','SAFE • standart kullanıcı');
  if (mode === 'FULL') return result('FULL_STANDARD_USER','FULL • standart kullanıcı');
  if (mode === 'CORE' && !facts.corePreferenceEnabled) {
    return result('CORE_OFF','CORE • kapalı',['CORE_PREFERENCE_NOT_ENABLED']);
  }
  const reasons: UiStatusReason[] = [];
  if (facts.accessMode !== 'full') reasons.push('FULL_REQUIRED');
  if (!facts.online) reasons.push('DEVICE_OFFLINE');
  if (!facts.currentOwnerSessionId) reasons.push('OWNER_SESSION_MISSING');
  if (facts.bridgeRequested === 'off') reasons.push('BRIDGE_REQUESTED_OFF');
  if (mode === 'ROOT') {
    const lease = facts.rootLease;
    const start = Date.parse(lease?.issuedAt ?? '');
    const end = Date.parse(lease?.expiresAt ?? '');
    const now = pins.now.getTime();
    if (!lease || lease.ownerAccountId !== facts.ownerAccountId ||
        lease.sessionId !== facts.currentOwnerSessionId || !Number.isFinite(now) ||
        !Number.isFinite(start) || !Number.isFinite(end) ||
        end <= now || start > now || end <= start || end - start > MAX_ROOT_LEASE_MS) {
      reasons.push('ROOT_LEASE_INVALID_OR_EXPIRED');
      return result('ROOT_EXPIRED','ROOT • süre doldu / geçersiz',reasons);
    }
  }
  if (reasons.length) return result('PAUSED_UNVERIFIED',`${mode} • yetki doğrulanamadı`,reasons);
  const evidence = validateEvidence(facts,pins,signed);
  if (evidence === 'revoked') return result('PAUSED_UNVERIFIED',`${mode} • iptal edildi`,['CORE_REVOKED_OR_STALE_EPOCH']);
  if (evidence !== 'valid') return result('PAUSED_UNVERIFIED',`${mode} • yetki doğrulanamadı`,
    ['BROKER_OR_WITNESS_PROOF_MISSING_OR_INVALID']);
  return result(mode === 'CORE' ? 'CORE_SIGNED_BROKER' : 'ROOT_SIGNED_BROKER',
    `${mode} • imzalı Broker kanıtı doğrulandı`,[],
    'signed-native-and-external-epoch-candidate');
}
