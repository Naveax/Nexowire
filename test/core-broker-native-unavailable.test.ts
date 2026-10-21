import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectCoreBrokerPreflight,
  type BrokerStatusRequest, type BrokerTokenEvidence,
  type ParentImportEvidence, type RunningBrokerImage,
} from "../src/diagnostics/core-broker-readonly-preflight.js";
import {
  createConservativeNativeBrokerProvider,
  type NativeWitnessReaders,
} from "../src/diagnostics/core-broker-native-unavailable.js";

const now = "2026-10-21T17:00:00.000Z";
const ownerId = "fixture-owner", deviceId = "fixture-device";
const expectation = {
  ownerId, deviceId, minimumGrantEpoch: 17,
  pinnedPublisherThumbprint: "b".repeat(40),
  observedNow: new Date(now), statusRequestId: "fresh-request-1",
};
const reported = <T>(value: T) => ({ state: "reported" as const, value, observedAt: now });
function green(): NativeWitnessReaders {
  return {
    readRunningImage: async () => reported<RunningBrokerImage>({
      pid: 4321, running: true, authenticodeValid: true,
      publisherPinned: true, publisherThumbprint: "b".repeat(40),
      imageBoundToRunningPid: true, imageSha256: "a".repeat(64), version: "1.0.5",
    }),
    readWindowsToken: async () => reported<BrokerTokenEvidence>({
      pid: 4321, integrity: "high", adminEnabled: true, tokenBoundToProcess: true,
    }),
    readParentImports: async () => reported<ParentImportEvidence>({
      parentChainProtected: true, importTreeProtected: true,
      noUntrustedWrite: true, boundToRunningImage: true,
      updaterPathProtected: true, updaterImportsProtected: true,
      updaterNoUntrustedWrite: true, updaterBoundToRunningImage: true,
    }),
    readOwnerCoreGrant: async () => reported({
      ownerId, deviceId, epoch: 17, active: true,
      ownerSignatureVerified: true, revocationChecked: true,
    }),
    readExternalWitness: async () => reported({
      ownerId, deviceId, epoch: 17,
      externalCasVerified: true, signedReceiptVerified: true, revoked: false,
    }),
    readStatusRequest: async () => reported<BrokerStatusRequest>({
      requestId: "fresh-request-1", responseRequestId: "fresh-request-1",
      transportStatus: "completed", httpStatus: 200,
      responseFromCache: false, claimedAuthenticated: true,
    }),
    readUntrustedSignals: async () => reported({}),
  };
}
async function inspect(readers: NativeWitnessReaders = green()) {
  return inspectCoreBrokerPreflight(createConservativeNativeBrokerProvider(readers), expectation);
}
test("native provider with no installed witnesses is UNAVAILABLE rather than SAFE", async () => {
  const r = await inspect({});
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.items.length, 7);
  assert.ok(r.items.every(x => x.state === "unavailable"));
  assert.equal(r.actualWindowsElevation, "NOT_PROVEN");
  assert.equal(r.brokerMayExecute, false);
  assert.ok(r.reasons.includes("EXTERNAL_WITNESS_UNAVAILABLE"));
});
test("native reader failure is UNAVAILABLE without leaking errors or credentials", async () => {
  const r = await inspect({
    readWindowsToken: async () => { throw new Error("CREDENTIAL_DO_NOT_LEAK"); },
    readExternalWitness: async () => { throw new Error("SECRET_DO_NOT_LEAK"); },
  });
  assert.equal(r.items.find(x => x.probe === "windowsToken")?.state, "unavailable");
  assert.ok(!JSON.stringify(r).includes("DO_NOT_LEAK"));
});
test("malformed native response is UNAVAILABLE", async () => {
  const r = await inspect({ readRunningImage: async () => ({ bogus: "success" } as never) });
  assert.equal(r.items.find(x => x.probe === "runningImage")?.state, "unavailable");
});
test("all-green synthetic native readings never grant CORE or Broker execution", async () => {
  const r = await inspect();
  assert.equal(r.outcome, "BLOCKED");
  assert.ok(r.reasons.includes("STATUS_REQUEST_NOT_ELEVATION"));
  assert.equal(r.authorizationGranted, false);
  assert.equal(r.actualWindowsElevation, "NOT_PROVEN");
  assert.equal(r.effectiveCore, false);
});
test("replay-cached 401 with matching request nonce is still denied", async () => {
  const r = await inspect({
    ...green(), readStatusRequest: async () => reported<BrokerStatusRequest>({
      requestId: "fresh-request-1", responseRequestId: "fresh-request-1",
      transportStatus: "completed", httpStatus: 401,
      responseFromCache: true, claimedAuthenticated: true,
    }),
  });
  assert.ok(r.reasons.includes("STATUS_REQUEST_REPLAY_OR_CACHE"));
  assert.ok(r.reasons.includes("STATUS_REQUEST_NOT_ELEVATION"));
  assert.equal(r.brokerMayExecute, false);
});
test("cached 401 reused after a fresh nonce is uncorrelated and blocked", async () => {
  const p = createConservativeNativeBrokerProvider({
    ...green(), readStatusRequest: async () => reported<BrokerStatusRequest>({
      requestId: "fresh-request-1", responseRequestId: "fresh-request-1",
      transportStatus: "completed", httpStatus: 401,
      responseFromCache: true, claimedAuthenticated: false,
    }),
  });
  const a = await inspectCoreBrokerPreflight(p, expectation);
  const b = await inspectCoreBrokerPreflight(p, { ...expectation, statusRequestId: "fresh-request-2" });
  assert.ok(a.reasons.includes("STATUS_REQUEST_REPLAY_OR_CACHE"));
  assert.ok(b.reasons.includes("STATUS_REQUEST_UNCORRELATED"));
  assert.equal(b.authorizationGranted, false);
});
test("401 with missing response nonce cannot claim authenticated status", async () => {
  const r = await inspect({
    ...green(), readStatusRequest: async () => reported<BrokerStatusRequest>({
      requestId: "fresh-request-1", responseRequestId: null,
      transportStatus: "completed", httpStatus: 401,
      responseFromCache: false, claimedAuthenticated: false,
    }),
  });
  assert.ok(r.reasons.includes("STATUS_REQUEST_UNCORRELATED"));
  assert.equal(r.actualWindowsElevation, "NOT_PROVEN");
});
test("consent.exe and UI/401 telemetry never fills missing trusted native providers", async () => {
  const r = await inspect({
    readUntrustedSignals: async () => reported({
      consentExeVisible: true, uiCoreBadge: true, unauthenticatedHttpStatus: 401,
    }),
  });
  assert.ok(r.reasons.includes("CONSENT_EXE_NOT_APPROVAL"));
  assert.ok(r.reasons.includes("UNAUTHENTICATED_401_NOT_ELEVATION"));
  assert.equal(r.items.find(x => x.probe === "windowsToken")?.state, "unavailable");
});
test("updater ACL unprotected despite protected parent/import blocks", async () => {
  const r = await inspect({
    ...green(), readParentImports: async () => reported<ParentImportEvidence>({
      parentChainProtected: true, importTreeProtected: true,
      noUntrustedWrite: true, boundToRunningImage: true,
      updaterPathProtected: false, updaterImportsProtected: true,
      updaterNoUntrustedWrite: false, updaterBoundToRunningImage: true,
    }),
  });
  assert.ok(r.reasons.includes("UPDATER_ACL_UNTRUSTED"));
  assert.equal(r.authorizationGranted, false);
});
test("valid signature cannot override a mismatched pinned Authenticode publisher", async () => {
  const r = await inspect({
    ...green(), readRunningImage: async () => reported<RunningBrokerImage>({
      pid: 4321, running: true, authenticodeValid: true,
      publisherPinned: true, publisherThumbprint: "c".repeat(40),
      imageBoundToRunningPid: true, imageSha256: "a".repeat(64), version: "1.0.5",
    }),
  });
  assert.ok(r.reasons.includes("BROKER_PUBLISHER_PIN_MISMATCH"));
  assert.equal(r.outcome, "BLOCKED");
});
test("missing external monotonic witness cannot be replaced by current owner grant", async () => {
  const r = await inspect({ ...green(), readExternalWitness: undefined });
  assert.ok(r.reasons.includes("EXTERNAL_WITNESS_UNAVAILABLE"));
  assert.equal(r.items.find(x => x.probe === "ownerCoreGrant")?.state, "reported_consistent");
  assert.equal(r.effectiveCore, false);
});
test("unknown native status is not evidence of a signed high-token Broker", async () => {
  const r = await inspect({ ...green(), readStatusRequest: async () => ({ state: "unknown" }) });
  assert.equal(r.items.find(x => x.probe === "statusRequest")?.state, "unknown");
  assert.equal(r.authorizationGranted, false);
});
