import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectCoreBrokerPreflight,
  type BrokerReadonlyProvider,
  type BrokerPreflightCode,
  type BrokerProbeName,
  type BrokerProbeState,
  type ProbeEnvelope,
  type RunningBrokerImage,
  type BrokerTokenEvidence,
  type ParentImportEvidence,
  type OwnerCoreGrantEvidence,
  type ExternalWitnessEvidence,
  type UntrustedSignals,
} from "../src/diagnostics/core-broker-readonly-preflight.js";

const now = "2026-10-21T15:00:00.000Z";
const ownerId = "owner-synthetic";
const deviceId = "device-synthetic";
const headSha = "a".repeat(64);
const expectations = {
  ownerId, deviceId, minimumGrantEpoch: 43, observedNow: new Date(now),
};
function probe<T>(value: T, observedAt = now): ProbeEnvelope<T> {
  return { state: "reported", observedAt, value };
}
function validSource(): BrokerReadonlyProvider {
  return {
    readRunningImage: async () => probe<RunningBrokerImage>({
      pid: 1600, running: true, authenticodeValid: true, publisherPinned: true,
      imageBoundToRunningPid: true, imageSha256: headSha, version: "1.0.5",
    }),
    readWindowsToken: async () => probe<BrokerTokenEvidence>({
      pid: 1600, integrity: "high", adminEnabled: true, tokenBoundToProcess: true,
    }),
    readParentImports: async () => probe<ParentImportEvidence>({
      parentChainProtected: true, importTreeProtected: true,
      noUntrustedWrite: true, boundToRunningImage: true,
    }),
    readOwnerCoreGrant: async () => probe<OwnerCoreGrantEvidence>({
      ownerId, deviceId, epoch: 43, active: true,
      ownerSignatureVerified: true, revocationChecked: true,
    }),
    readExternalWitness: async () => probe<ExternalWitnessEvidence>({
      ownerId, deviceId, epoch: 43,
      externalCasVerified: true, signedReceiptVerified: true, revoked: false,
    }),
    readUntrustedSignals: async () => probe<UntrustedSignals>({}),
  };
}
function replace<K extends keyof BrokerReadonlyProvider>(
  key: K, implementation: NonNullable<BrokerReadonlyProvider[K]>,
): BrokerReadonlyProvider {
  return { ...validSource(), [key]: implementation };
}
function codeReport(items: readonly {probe: BrokerProbeName, codes: readonly BrokerPreflightCode[]}[],
  key: BrokerProbeName, code: BrokerPreflightCode) {
  assert.ok(items.find(v => v.probe === key)?.codes.includes(code),
    "missing " + key + ":" + code);
}
test("ALL synthetic green claims remain source-only unverified, never effective CORE", async () => {
  const r = await inspectCoreBrokerPreflight(validSource(), expectations);
  assert.equal(r.outcome, "UNVERIFIED");
  assert.equal(r.origin, "injected_provider_untrusted");
  assert.equal(r.authorizationGranted, false);
  assert.equal(r.effectiveCore, false);
  assert.equal(r.actualWindowsElevation, "NOT_PROVEN");
  assert.equal(r.trustedAttestation, false);
  assert.equal(r.brokerMayExecute, false);
  assert.deepEqual(r.items.map(i => i.state), Array(6).fill("reported_consistent"));
  assert.ok(r.reasons.includes("PROVIDER_CLAIMS_NOT_ATTESTATION"));
});
test("Medium Windows Agent/Broker token is not elevated by requested CORE", async () => {
  const p = replace("readWindowsToken", async () => probe<BrokerTokenEvidence>({
    pid: 1600, integrity: "medium", adminEnabled: false, tokenBoundToProcess: true,
  }));
  const r = await inspectCoreBrokerPreflight(p, expectations);
  assert.equal(r.outcome, "BLOCKED");
  codeReport(r.items, "windowsToken", "BROKER_TOKEN_NOT_HIGH");
});
test("forged token with High claim but incorrect PID must fail independent binding", async () => {
  const p = replace("readWindowsToken", async () => probe<BrokerTokenEvidence>({
    pid: 9999, integrity: "high", adminEnabled: true, tokenBoundToProcess: true,
  }));
  const r = await inspectCoreBrokerPreflight(p, expectations);
  codeReport(r.items, "windowsToken", "BROKER_TOKEN_PID_MISMATCH");
  assert.equal(r.effectiveCore, false);
});
test("unsigned or unpinned running Broker image does not count as valid Authenticode", async () => {
  const p = replace("readRunningImage", async () => probe<RunningBrokerImage>({
    pid: 1600, running: true, authenticodeValid: false, publisherPinned: false,
    imageBoundToRunningPid: true, imageSha256: headSha, version: "1.0.5",
  }));
  const r = await inspectCoreBrokerPreflight(p, expectations);
  codeReport(r.items, "runningImage", "RUNNING_SIGNED_IMAGE_UNVERIFIED");
  assert.equal(r.outcome, "BLOCKED");
});
test("missing running-image hash or unbound image denies trust", async () => {
  const p = replace("readRunningImage", async () => probe<RunningBrokerImage>({
    pid: 1600, running: true, authenticodeValid: true, publisherPinned: true,
    imageBoundToRunningPid: false, imageSha256: "not-hash", version: "1.0.5",
  }));
  codeReport((await inspectCoreBrokerPreflight(p, expectations)).items,
    "runningImage", "RUNNING_SIGNED_IMAGE_UNVERIFIED");
});
test("protected parent but writable import tree is blocked", async () => {
  const p = replace("readParentImports", async () => probe<ParentImportEvidence>({
    parentChainProtected: true, importTreeProtected: false,
    noUntrustedWrite: false, boundToRunningImage: true,
  }));
  const r = await inspectCoreBrokerPreflight(p, expectations);
  codeReport(r.items, "parentImports", "PARENT_OR_IMPORT_UNTRUSTED");
  assert.equal(r.authorizationGranted, false);
});
test("missing ACL provider is UNAVAILABLE, not safe-by-absence", async () => {
  const p = replace("readParentImports", async () => {
    throw new Error("secret-token=NEVER_DISCLOSE_123");
  });
  const r = await inspectCoreBrokerPreflight(p, expectations);
  assert.equal(r.items.find(x => x.probe === "parentImports")?.state, "unavailable");
  codeReport(r.items, "parentImports", "PROVIDER_UNAVAILABLE");
  assert.equal(JSON.stringify(r).includes("NEVER_DISCLOSE"), false);
});
test("unknown ACL or imported binary cannot satisfy effective ACL", async () => {
  const p = replace("readParentImports",
    async () => ({ state: "unknown" as BrokerProbeState }));
  const r = await inspectCoreBrokerPreflight(p, expectations);
  assert.equal(r.items.find(x => x.probe === "parentImports")?.state, "unknown");
  assert.equal(r.outcome, "BLOCKED");
});
test("current owner/device mismatches or stale epoch block CORE delegation", async () => {
  const p = replace("readOwnerCoreGrant", async () => probe<OwnerCoreGrantEvidence>({
    ownerId: "foreign-owner", deviceId, epoch: 42, active: true,
    ownerSignatureVerified: true, revocationChecked: true,
  }));
  const r = await inspectCoreBrokerPreflight(p, expectations);
  codeReport(r.items, "ownerCoreGrant", "CORE_OWNER_GRANT_NOT_CURRENT");
  codeReport(r.items, "ownerCoreGrant", "CORE_OWNER_EPOCH_STALE");
});
test("revoked current CORE grant cannot be overridden by a signed-looking Broker", async () => {
  const p = replace("readOwnerCoreGrant", async () => probe<OwnerCoreGrantEvidence>({
    ownerId, deviceId, epoch: 43, active: false,
    ownerSignatureVerified: true, revocationChecked: true,
  }));
  const r = await inspectCoreBrokerPreflight(p, expectations);
  codeReport(r.items, "ownerCoreGrant", "CORE_OWNER_GRANT_NOT_CURRENT");
  assert.equal(r.outcome, "BLOCKED");
});
test("external witness unavailable means unknown monotonic authority, never granted", async () => {
  const p = replace("readExternalWitness", async () => { throw new Error("provider unavailable"); });
  const r = await inspectCoreBrokerPreflight(p, expectations);
  codeReport(r.items, "externalWitness", "EXTERNAL_WITNESS_UNAVAILABLE");
  assert.equal(r.items.find(x=>x.probe === "externalWitness")?.state, "unavailable");
  assert.equal(r.brokerMayExecute, false);
});
test("unknown external witness is blocked even when owner epoch looks current", async () => {
  const p = replace("readExternalWitness", async () => ({ state: "unknown" }));
  const r = await inspectCoreBrokerPreflight(p, expectations);
  codeReport(r.items, "externalWitness", "EXTERNAL_WITNESS_UNAVAILABLE");
  assert.equal(r.outcome, "BLOCKED");
});
test("synthetic in-memory CAS claiming externality=false is never authoritative", async () => {
  const p = replace("readExternalWitness", async () => probe<ExternalWitnessEvidence>({
    ownerId, deviceId, epoch: 43,
    externalCasVerified: false, signedReceiptVerified: false, revoked: false,
  }));
  const r = await inspectCoreBrokerPreflight(p, expectations);
  codeReport(r.items, "externalWitness", "EXTERNAL_WITNESS_NOT_VERIFIED");
});
test("rollback older witness / inconsistent grant epoch is blocked", async () => {
  const p = replace("readExternalWitness", async () => probe<ExternalWitnessEvidence>({
    ownerId, deviceId, epoch: 41,
    externalCasVerified: true, signedReceiptVerified: true, revoked: false,
  }));
  const r = await inspectCoreBrokerPreflight(p, expectations);
  codeReport(r.items, "externalWitness", "EXTERNAL_WITNESS_EPOCH_MISMATCH");
});
test("external witness explicitly revokes same CORE epoch", async () => {
  const p = replace("readExternalWitness", async () => probe<ExternalWitnessEvidence>({
    ownerId, deviceId, epoch: 43,
    externalCasVerified: true, signedReceiptVerified: true, revoked: true,
  }));
  const r = await inspectCoreBrokerPreflight(p, expectations);
  codeReport(r.items, "externalWitness", "CORE_OWNER_REVOKED");
  assert.equal(r.outcome, "BLOCKED");
});
test("consent.exe, HTTP 401 and CORE UI badge cannot stand in for independent evidence", async () => {
  const p = replace("readUntrustedSignals", async () => probe<UntrustedSignals>({
    consentExeVisible: true, unauthenticatedHttpStatus: 401, uiCoreBadge: true,
  }));
  const r = await inspectCoreBrokerPreflight(p, expectations);
  codeReport(r.items, "untrustedSignals", "CONSENT_EXE_NOT_APPROVAL");
  codeReport(r.items, "untrustedSignals", "UNAUTHENTICATED_401_NOT_ELEVATION");
  codeReport(r.items, "untrustedSignals", "UI_CORE_BADGE_NOT_ELEVATION");
  assert.equal(r.effectiveCore, false);
});
test("malformed provider response cannot be coerced into success", async () => {
  const p = replace("readRunningImage", async () => ({} as ProbeEnvelope<RunningBrokerImage>));
  const r = await inspectCoreBrokerPreflight(p, expectations);
  codeReport(r.items, "runningImage", "PROVIDER_UNAVAILABLE");
  assert.equal(r.outcome, "BLOCKED");
});
test("stale and future observations are not current attestations", async () => {
  for (const time of ["2026-10-21T14:50:00.000Z", "2026-10-21T15:02:00.000Z"]) {
    const p = replace("readOwnerCoreGrant", async () => probe<OwnerCoreGrantEvidence>({
      ownerId, deviceId, epoch: 43, active: true,
      ownerSignatureVerified: true, revocationChecked: true,
    }, time));
    const r = await inspectCoreBrokerPreflight(p, expectations);
    codeReport(r.items, "ownerCoreGrant", "EVIDENCE_STALE_OR_FUTURE");
  }
});
test("negative, fractional, wrong-account or wrong-device expected epoch invalid before probes", async () => {
  for (const wrong of [-1, 4.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => inspectCoreBrokerPreflight(validSource(),
      {...expectations, minimumGrantEpoch: wrong}), /Invalid scoped/);
  }
  await assert.rejects(() => inspectCoreBrokerPreflight(validSource(),
    {...expectations, ownerId: ""}), /Invalid scoped/);
});
test("no missing-provider result can ever be promoted by the remaining positive reports", async () => {
  const p = { ...validSource(), readRunningImage: undefined } as unknown as BrokerReadonlyProvider;
  const r = await inspectCoreBrokerPreflight(p, expectations);
  assert.equal(r.items.find(x=>x.probe === "runningImage")?.state, "unknown");
  assert.equal(r.authorizationGranted, false);
});
