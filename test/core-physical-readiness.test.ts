import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  explainCorePhysicalReadiness,
  type CorePhysicalFacts,
} from "../src/diagnostics/core-physical-readiness.js";

function synthetic(overrides: Partial<CorePhysicalFacts> = {}): CorePhysicalFacts {
  return {
    requestedMode: "CORE",
    claimedOrigin: "synthetic_fixture",
    agent: { version: "1.0.5", integrity: "medium",
      adminRoleInProcess: false, administratorsDenyOnly: true },
    ownerDelegation: { deviceOwnerBound: "unverified", rootLeaseUnexpired: null,
      rootSessionBound: "unverified", coreEnrollmentActive: "unverified",
      revocationChecked: "unverified" },
    broker: { port43112ListenerSeen: true, authenticatedHealth: "unverified",
      signedBinary: "unverified", versionMatch: "unverified",
      elevatedToken: "unverified", protectedParentAndImports: "unverified",
      broadWriteAceObserved: true },
    vm: { observedState: "unknown", independentlyAuthenticatedReadback: "unverified" },
    ...overrides,
  };
}

test("tiny source-only JSON fixture stays synthetic and cannot grant CORE", () => {
  const fixtureUrl = new URL("./fixtures/core-medium-untrusted-fixture.json", import.meta.url);
  const raw = readFileSync(fixtureUrl);
  assert.ok(raw.byteLength < 2048, "tiny source fixture, no real disk-transfer test");
  const facts = JSON.parse(raw.toString("utf8")) as CorePhysicalFacts;
  const report = explainCorePhysicalReadiness(facts);
  assert.equal(report.claimedOrigin, "synthetic_fixture");
  assert.equal(report.authorizationGranted, false);
  assert.equal(report.productionReadiness, "blocked");
});
test("medium integrity + Administrators deny-only never makes requested CORE effective", () => {
  const report = explainCorePhysicalReadiness(synthetic());
  assert.equal(report.requestedMode, "CORE");
  assert.equal(report.effectiveElevation, "not_proven");
  assert.equal(report.productionReadiness, "blocked");
  assert.equal(report.authorizationGranted, false);
  assert.ok(report.reasons.includes("DIRECT_AGENT_MEDIUM_OR_NOT_ADMIN"));
});
test("43112 listener is not an authenticated elevated broker", () => {
  const report = explainCorePhysicalReadiness(synthetic());
  assert.equal(report.brokerListenerObserved, true);
  assert.ok(report.reasons.includes("BROKER_LISTENER_NOT_AUTHENTICATION"));
  assert.ok(report.reasons.includes("BROKER_AUTHENTICATED_HEALTH_UNVERIFIED"));
});
test("broad inherited Modify or Write ACE is untrusted; no safe ACL inference", () => {
  const report = explainCorePhysicalReadiness(synthetic());
  assert.ok(report.reasons.includes("UNTRUSTED_PARENT_OR_IMPORT_ACL"));
  assert.equal(report.productionReadiness, "blocked");
});
test("missing ACL cannot be promoted to verified even without visible broad write", () => {
  const facts = synthetic({broker: {...synthetic().broker,
    broadWriteAceObserved: false, protectedParentAndImports: "unverified" }});
  const report = explainCorePhysicalReadiness(facts);
  assert.ok(report.reasons.includes("BROKER_ACL_UNVERIFIED"));
  assert.equal(report.authorizationGranted, false);
});
test("FULL cannot turn standard token into Windows elevated authority", () => {
  const report = explainCorePhysicalReadiness(synthetic({requestedMode: "FULL"}));
  assert.equal(report.effectiveElevation, "not_proven");
  assert.ok(report.reasons.includes("DIRECT_AGENT_MEDIUM_OR_NOT_ADMIN"));
});
test("ROOT requires an unexpired session-bound 15-minute lease evidence", () => {
  const report = explainCorePhysicalReadiness(synthetic({
    requestedMode: "ROOT", ownerDelegation: {...synthetic().ownerDelegation,
      rootLeaseUnexpired: true, rootSessionBound: "unverified" },
  }));
  assert.ok(report.reasons.includes("ROOT_LEASE_OR_SESSION_UNVERIFIED"));
});
test("CORE preference is not durable attested delegation or revocation proof", () => {
  const report = explainCorePhysicalReadiness(synthetic({
    ownerDelegation: {...synthetic().ownerDelegation, coreEnrollmentActive: "verified",
      revocationChecked: "unverified"},
  }));
  assert.ok(report.reasons.includes("CORE_ENROLLMENT_OR_REVOCATION_UNVERIFIED"));
});
test("VM UNKNOWN cannot become Running from UAC prompt, port listener or request receipt", () => {
  const report = explainCorePhysicalReadiness(synthetic());
  assert.ok(report.reasons.includes("VM_STATE_UNKNOWN_OR_UNATTESTED"));
  assert.equal(report.vmEffectVerified, false);
  assert.equal(report.mutationPerformed, false);
});
test("even all caller-claimed green flags cannot mint trusted elevation", () => {
  const report = explainCorePhysicalReadiness(synthetic({
    claimedOrigin: "live_readonly",
    agent: {version: "1.0.5", integrity: "high",
      adminRoleInProcess: true, administratorsDenyOnly: false},
    ownerDelegation: {deviceOwnerBound: "verified", rootLeaseUnexpired: true,
      rootSessionBound: "verified", coreEnrollmentActive: "verified",
      revocationChecked: "verified"},
    broker: {port43112ListenerSeen: true, authenticatedHealth: "verified",
      signedBinary: "verified", versionMatch: "verified",
      elevatedToken: "verified", protectedParentAndImports: "verified",
      broadWriteAceObserved: false},
    vm: {observedState: "running", independentlyAuthenticatedReadback: "verified"},
  }));
  assert.equal(report.claimedOrigin, "live_readonly");
  assert.equal(report.originCryptographicallyAttested, false);
  assert.equal(report.authorizationGranted, false);
  assert.equal(report.effectiveElevation, "not_proven");
  assert.equal(report.productionReadiness, "unverified");
  assert.ok(report.reasons.includes("OBSERVATION_PROVENANCE_SELF_ASSERTED"));
});
test("synthetic fixture explicitly remains synthetic and cannot claim physical readiness", () => {
  const report = explainCorePhysicalReadiness(synthetic());
  assert.equal(report.claimedOrigin, "synthetic_fixture");
  assert.equal(report.originCryptographicallyAttested, false);
  assert.equal(report.vmEffectVerified, false);
});
