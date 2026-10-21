/**
 * Independent, source-only, read-only CORE Broker preflight adapter.
 * The injected provider's values are NOT trusted host attestations.
 * No network calls, Windows token changes, Broker commands or UAC operations.
 */
export type BrokerProbeName =
  | "runningImage" | "windowsToken" | "parentImports"
  | "ownerCoreGrant" | "externalWitness" | "untrustedSignals";
export type BrokerProbeState = "reported" | "unavailable" | "unknown" | "error";
export type BrokerEvidenceState = "reported_consistent" | "blocked" | "unknown" | "unavailable";
export type WindowsIntegrity = "low" | "medium" | "high" | "system" | "unknown";

export interface ProbeEnvelope<T> {
  readonly state: BrokerProbeState;
  readonly observedAt?: string;
  readonly value?: T;
}
export interface RunningBrokerImage {
  readonly pid: number;
  readonly running: boolean;
  readonly authenticodeValid: boolean;
  readonly publisherPinned: boolean;
  readonly imageBoundToRunningPid: boolean;
  readonly imageSha256: string;
  readonly version: string;
}
export interface BrokerTokenEvidence {
  readonly pid: number;
  readonly integrity: WindowsIntegrity;
  readonly adminEnabled: boolean;
  readonly tokenBoundToProcess: boolean;
}
export interface ParentImportEvidence {
  readonly parentChainProtected: boolean;
  readonly importTreeProtected: boolean;
  readonly noUntrustedWrite: boolean;
  readonly boundToRunningImage: boolean;
}
export interface OwnerCoreGrantEvidence {
  readonly ownerId: string;
  readonly deviceId: string;
  readonly epoch: number;
  readonly active: boolean;
  readonly ownerSignatureVerified: boolean;
  readonly revocationChecked: boolean;
}
export interface ExternalWitnessEvidence {
  readonly ownerId: string;
  readonly deviceId: string;
  readonly epoch: number;
  readonly externalCasVerified: boolean;
  readonly signedReceiptVerified: boolean;
  readonly revoked: boolean;
}
export interface UntrustedSignals {
  readonly unauthenticatedHttpStatus?: number;
  readonly consentExeVisible?: boolean;
  readonly uiCoreBadge?: boolean;
}
export interface BrokerReadonlyProvider {
  readonly readRunningImage: () => Promise<ProbeEnvelope<RunningBrokerImage>>;
  readonly readWindowsToken: () => Promise<ProbeEnvelope<BrokerTokenEvidence>>;
  readonly readParentImports: () => Promise<ProbeEnvelope<ParentImportEvidence>>;
  readonly readOwnerCoreGrant: () => Promise<ProbeEnvelope<OwnerCoreGrantEvidence>>;
  readonly readExternalWitness: () => Promise<ProbeEnvelope<ExternalWitnessEvidence>>;
  readonly readUntrustedSignals?: () => Promise<ProbeEnvelope<UntrustedSignals>>;
}
export interface BrokerPreflightExpectations {
  readonly ownerId: string;
  readonly deviceId: string;
  readonly minimumGrantEpoch: number;
  /** Only validates timestamps; no caller-provided clock is trusted attestation. */
  readonly observedNow: Date;
  readonly maxObservationAgeMs?: number;
}
export type BrokerPreflightCode =
  | "PROVIDER_UNAVAILABLE" | "PROBE_UNKNOWN" | "PROBE_MALFORMED"
  | "EVIDENCE_STALE_OR_FUTURE"
  | "RUNNING_SIGNED_IMAGE_UNVERIFIED" | "BROKER_TOKEN_NOT_HIGH"
  | "BROKER_TOKEN_PID_MISMATCH" | "PARENT_OR_IMPORT_UNTRUSTED"
  | "CORE_OWNER_GRANT_NOT_CURRENT" | "CORE_OWNER_EPOCH_STALE"
  | "CORE_OWNER_REVOKED" | "EXTERNAL_WITNESS_UNAVAILABLE"
  | "EXTERNAL_WITNESS_NOT_VERIFIED" | "EXTERNAL_WITNESS_EPOCH_MISMATCH"
  | "UNAUTHENTICATED_401_NOT_ELEVATION" | "CONSENT_EXE_NOT_APPROVAL"
  | "UI_CORE_BADGE_NOT_ELEVATION" | "PROVIDER_CLAIMS_NOT_ATTESTATION";

export interface BrokerEvidenceItem {
  readonly probe: BrokerProbeName;
  readonly state: BrokerEvidenceState;
  readonly codes: readonly BrokerPreflightCode[];
}
export interface BrokerPreflightResult {
  readonly version: 1;
  readonly origin: "injected_provider_untrusted";
  readonly purpose: "read_only_diagnostic";
  readonly requestedMode: "CORE";
  readonly authorizationGranted: false;
  readonly actualWindowsElevation: "NOT_PROVEN";
  readonly effectiveCore: false;
  readonly trustedAttestation: false;
  readonly brokerMayExecute: false;
  readonly outcome: "BLOCKED" | "UNVERIFIED";
  readonly items: readonly BrokerEvidenceItem[];
  readonly reasons: readonly BrokerPreflightCode[];
}

type AnyEnvelope = ProbeEnvelope<unknown>;
function isObj(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function goodSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}
function textId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function envelopeValid(value: unknown): value is AnyEnvelope {
  return isObj(value) && ["reported", "unavailable", "unknown", "error"].includes(String(value.state));
}
async function sample<T>(read: (() => Promise<ProbeEnvelope<T>>) | undefined): Promise<AnyEnvelope> {
  if (!read) return { state: "unknown" };
  try {
    const result: unknown = await read();
    return envelopeValid(result) ? result : { state: "error" };
  } catch {
    // Deliberately do not expose provider error strings (could contain tokens).
    return { state: "unavailable" };
  }
}
function stateFor(envelope: AnyEnvelope, issues: readonly BrokerPreflightCode[]): BrokerEvidenceState {
  if (envelope.state === "unavailable" || envelope.state === "error") return "unavailable";
  if (envelope.state === "unknown") return "unknown";
  return issues.length ? "blocked" : "reported_consistent";
}
function item(
  probe: BrokerProbeName,
  envelope: AnyEnvelope,
  issues: readonly BrokerPreflightCode[],
): BrokerEvidenceItem {
  const state = stateFor(envelope, issues);
  const codes: BrokerPreflightCode[] = [...issues];
  if (state === "unavailable" && !codes.includes("PROVIDER_UNAVAILABLE")) codes.push("PROVIDER_UNAVAILABLE");
  if (state === "unknown" && !codes.includes("PROBE_UNKNOWN")) codes.push("PROBE_UNKNOWN");
  return { probe, state, codes };
}
function stale(envelope: AnyEnvelope, clock: number, maxAge: number): boolean {
  const t = Date.parse(String(envelope.observedAt ?? ""));
  return !Number.isFinite(t) || t > clock + 2000 || clock - t > maxAge;
}

/**
 * Source-only preflight; never derives operational authority from injected results.
 * Each source is observed independently; a provider can claim all-green values but
 * still cannot mint an elevation, an owner CORE grant, or an external CAS witness.
 */
export async function inspectCoreBrokerPreflight(
  provider: BrokerReadonlyProvider,
  expected: BrokerPreflightExpectations,
): Promise<BrokerPreflightResult> {
  if (!textId(expected.ownerId) || !textId(expected.deviceId) ||
      !safeEpoch(expected.minimumGrantEpoch) ||
      !(expected.observedNow instanceof Date) ||
      !Number.isFinite(expected.observedNow.getTime())) {
    throw new TypeError("Invalid scoped CORE preflight expectations");
  }
  const maxAge = expected.maxObservationAgeMs ?? 60000;
  if (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 300000) {
    throw new TypeError("Invalid CORE observation freshness window");
  }
  const [image, token, acl, grant, witness, signals] = await Promise.all([
    sample(provider.readRunningImage),
    sample(provider.readWindowsToken),
    sample(provider.readParentImports),
    sample(provider.readOwnerCoreGrant),
    sample(provider.readExternalWitness),
    sample(provider.readUntrustedSignals),
  ]);
  const clock = expected.observedNow.getTime();
  const issues = (p: AnyEnvelope): BrokerPreflightCode[] =>
    p.state !== "reported" ? [] :
    !isObj(p.value) ? ["PROBE_MALFORMED"] :
    stale(p, clock, maxAge) ? ["EVIDENCE_STALE_OR_FUTURE"] : [];

  const i = issues(image), t = issues(token), a = issues(acl),
    g = issues(grant), w = issues(witness), s = issues(signals);
  const iv = image.value, tv = token.value, av = acl.value,
    gv = grant.value, wv = witness.value, sv = signals.value;

  if (image.state === "reported" && isObj(iv) &&
      !(iv.running === true && Number.isSafeInteger(iv.pid) && Number(iv.pid) > 0 &&
        iv.authenticodeValid === true && iv.publisherPinned === true &&
        iv.imageBoundToRunningPid === true && goodSha(iv.imageSha256) &&
        textId(iv.version))) i.push("RUNNING_SIGNED_IMAGE_UNVERIFIED");
  if (token.state === "reported" && isObj(tv)) {
    if (!(tv.integrity === "high" || tv.integrity === "system") ||
        tv.adminEnabled !== true || tv.tokenBoundToProcess !== true) {
      t.push("BROKER_TOKEN_NOT_HIGH");
    }
    if (!isObj(iv) || !Number.isSafeInteger(tv.pid) || tv.pid !== iv.pid) {
      t.push("BROKER_TOKEN_PID_MISMATCH");
    }
  }
  if (acl.state === "reported" && isObj(av) &&
      !(av.parentChainProtected === true && av.importTreeProtected === true &&
        av.noUntrustedWrite === true && av.boundToRunningImage === true)) {
    a.push("PARENT_OR_IMPORT_UNTRUSTED");
  }
  if (grant.state === "reported" && isObj(gv)) {
    if (gv.ownerId !== expected.ownerId || gv.deviceId !== expected.deviceId ||
        gv.active !== true || gv.ownerSignatureVerified !== true ||
        gv.revocationChecked !== true || !safeEpoch(gv.epoch)) {
      g.push("CORE_OWNER_GRANT_NOT_CURRENT");
    }
    if (!safeEpoch(gv.epoch) || Number(gv.epoch) < expected.minimumGrantEpoch) {
      g.push("CORE_OWNER_EPOCH_STALE");
    }
  }
  if (witness.state === "reported" && isObj(wv)) {
    if (wv.ownerId !== expected.ownerId || wv.deviceId !== expected.deviceId ||
        wv.externalCasVerified !== true || wv.signedReceiptVerified !== true ||
        !safeEpoch(wv.epoch)) {
      w.push("EXTERNAL_WITNESS_NOT_VERIFIED");
    }
    if (wv.revoked === true) w.push("CORE_OWNER_REVOKED");
    if (!isObj(gv) || !safeEpoch(gv.epoch) || !safeEpoch(wv.epoch) ||
        gv.epoch !== wv.epoch || Number(wv.epoch) < expected.minimumGrantEpoch) {
      w.push("EXTERNAL_WITNESS_EPOCH_MISMATCH");
    }
  }
  if (witness.state === "unavailable" || witness.state === "error" ||
      witness.state === "unknown") w.push("EXTERNAL_WITNESS_UNAVAILABLE");
  if (signals.state === "reported" && isObj(sv)) {
    if (sv.unauthenticatedHttpStatus === 401) s.push("UNAUTHENTICATED_401_NOT_ELEVATION");
    if (sv.consentExeVisible === true) s.push("CONSENT_EXE_NOT_APPROVAL");
    if (sv.uiCoreBadge === true) s.push("UI_CORE_BADGE_NOT_ELEVATION");
  }
  const result = [
    item("runningImage", image, i),
    item("windowsToken", token, t),
    item("parentImports", acl, a),
    item("ownerCoreGrant", grant, g),
    item("externalWitness", witness, w),
    item("untrustedSignals", signals, s),
  ];
  const reasons = [...new Set([
    ...result.flatMap(entry => entry.codes),
    "PROVIDER_CLAIMS_NOT_ATTESTATION" as BrokerPreflightCode,
  ])];
  return {
    version: 1,
    origin: "injected_provider_untrusted",
    purpose: "read_only_diagnostic",
    requestedMode: "CORE",
    authorizationGranted: false,
    actualWindowsElevation: "NOT_PROVEN",
    effectiveCore: false,
    trustedAttestation: false,
    brokerMayExecute: false,
    outcome: result.some(entry => entry.state !== "reported_consistent") ? "BLOCKED" : "UNVERIFIED",
    items: result,
    reasons,
  };
}
