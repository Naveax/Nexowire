# #12 | Self-host worker installer provider: second-pass source acceptance

**2026-10-23. Owner #12, #780 P1, coordinator #539. DRAFT SPEC ONLY; PHYSICAL NO-GO.**
Parent #804 HEAD `5bff77c424c1c90fd52daf26851cfc8c7ab1310f`, CI `39841139045` 7/7 SUCCESS, **docs-only**.
Independent QA #41 PR #827 HEAD `efabcdb9bea3e3b0dfd83297f84a7c1718210c4e`, CI `39863071860` 7/7 SUCCESS; 9 TEMP/Ed25519 fixture negative tests, **not** native Authenticode, OS token or external CAS.
Canonical G00–G08 minimum-gates remain `docs/S3_SELF_HOST_WORKER_MINIMUM_INSTALL_ACCEPTANCE_20261022.md`; this addendum specifies the missing #12 *physical provider interface* and test handoff **without implementing it**.

## 1. Exact current API inventory (why no owner execution test can yet be connected)

| Current source | Verified behavior | Why not the missing worker provider |
| --- | --- | --- |
| `src/agent/native-agent-lifecycle.ts:481-515` | Registers the **existing Native Agent** task as the **current Windows identity** with `-RunLevel Limited`, an interactive logon and a local launcher | Same-user Agent lifecycle; no independently installed `coding-worker` SID or non-exportable key |
| `src/self-host-bootstrap.ts:216-223,259-319` | Same-account Hub/Native Agent bootstrap and two different bearer tokens protected by CurrentUser DPAPI | Separate bearer tokens do not establish distinct OS login or per-worker signing key |
| `src/agent/process-worker.ts:198-226,420-439` | Launches a managed command, keeps child/control/status; private-desktop identity recheck | No bounded separately enrolled *coding* worker installer or restricted token deployment |
| `src/agent/windows-installer-job.ts:12-19,48-76,86-115,325-357` | Real **generic** protected Broker-path job with approved package hash/argv and optional publisher thumbprint | Not a worker-specific *low-integrity* install, signed PE import/dependency release, one-use worker enrollment or native worker rollback |
| `scripts/s3-release-bundle-audit.ts:121-229` and S3 CORE source gates | Target and rollback Agent/Authenti­code and protected-tree **offline checks**, with `executionSafe:false`/`productionApproved:false` | Does not install a worker or provide a trusted deployed signer, lowpriv token or external owner authority |
| `src/security/windows-machine-update-tree-trust.ts` and `windows-privileged-runtime-trust.ts` | Read-only checks for protected privileged machine-updater/runtime | Those roots/signers are not an independently attested worker-only package |
| `src/product/owner-public-wss-windows-dpapi-staging.ts:14-16,43-56` | TEMP Ed25519 PKCS#8 private key sealed with CurrentUser DPAPI and later held in Node | Test key is exportable; not worker principal-exclusive CNG/TPM/KSP key or native certificate |
| `src/protocol/guardian-key-enrollment-proof.ts:58-70`, #792 OAuth owner principal | Signing-key possession, or current owner OAuth authentication only | Neither signs an externally consumed and revocable worker grant nor upgrades to service rights |
| `src/agent/operation-journal.ts`, `src/workspace/artifact-checkpoint-adapter.ts` | Agent WAL metadata anti-replay/UNKNOWN and workspace snapshot linkage | Not an off-host owner/CAS reservation or safe task resume; adapter copies `summary`/`lastCommands` as metadata, no demonstrated secret redaction |

**Observed source disposition:** No reviewed production `workerInstaller.stage/commit/rollback`, `workerIdentity.enroll/revoke`, or separate lowpriv worker native provider API exists. Adding a test that always returns `DENIED` to a new mock would only manufacture another synthetic green result. #827 already covers those fixture classes independently. No #12 production files or #827 QA are changed here.

## 2. Future physical provider contract (NOT an existing API)

The eventual install adapter is allowed to evaluate a read-only native witness, not to treat a JSON claim from the MCP caller as an OS fact. Split provider interfaces at the trust boundary:

```ts
// CONTRACT ONLY. Future native signed providers must produce these.
type WorkerPackagePin = {
  publisherCertDerSha256: string; // independently provisioned
  releaseManifestSha256: string; // signed worker-only manifest
  packageRole: 'self-host-coding-worker';
  releaseSequence: number;      // external monotonic floor
  executableImportsAndRollbackSha256: readonly string[];
};
type WorkerOsWitness = {
  trustedNativeIssuer: string;
  deviceId: string;
  workerSid: string;
  agentSid: string;
  hubSid: string;
  brokerSid: string;
  processCreationFileTime: string;
  lowIntegrityTokenVerified: boolean;
  independentWorkerLogonVerified: boolean;
  separateSignerKspVerified: boolean;
  keyNonExportableVerified: boolean;
  deniedProtectedImportAndRollbackWrites: boolean;
  deniedAgentOrBrokerTokenAndHandleAccess: boolean;
  deniedOutOfRootAndSecretAccess: boolean;
};
type ExternalOwnerAdmission = {
  issuer: 'independent-owner-admission';
  ownerAccountId: string;
  workerDeviceId: string;
  workerSignerSpkiSha256: string;
  hostIdentitySha256: string;
  ownerEpoch: number;
  grantGeneration: number;
  enrollmentNonce: string;
  requestId: string;
  approvedWorktreeSha256: string;
  consumedExactlyOnce: true;
  revokeStartIsLinearizableWithDispatch: true;
  witnessedFromNonRollbackableAuthority: true;
};
type WorkerLifecycleOutcome =
  | { state: 'DENIED'; installAllowed: false; dispatchAllowed: false }
  | { state: 'RECONCILE_REQUIRED'; installAllowed: false; dispatchAllowed: false }
  | { state: 'PHYSICAL_PROVIDER_UNAVAILABLE'; installAllowed: false; dispatchAllowed: false };
// No permitted success case exists in the current implementation.
```

This shape is a **minimum security handoff**, not an attempt to pin physical trust to attacker-supplied booleans. Native issuer/publisher cert, actual opened FileID/volume, OS token/SID, immutable key handle, non-rollbackable CAS and durable last-write receipts must be **independently verified** by separate provider code before any mutating install adapter may exist. All source-only receipts remain `installAllowed:false`.

## 3. Exactly ordered installation and recovery transaction

1. **Prepare without executing:** independently pin a **worker-only** signed release, normal + delay + dynamic import closure, launcher/updater, complete rollback and certificate DER fingerprint. Require monotonic release floor from off-host trusted state, not old disk. Verify every native parent against actual lower-privilege write, rename, ACL takeover and reparse; pin physical volume/FileID at read and commit.
2. **OS principal and key separation:** independently provision a *different* unprivileged worker account/SID from Native Agent/Hub/Broker/SYSTEM; enforce read-only protected installer assets and isolated worktree. Hardware/OS provider creates a fresh non-exportable key usable **only** by that SID. Key roles and fingerprints cannot be recycled between worker A/B or reused from Agent, Guardian TEMP, cloud, or Broker.
3. **Owner enrollment admission:** current OAuth owner principal from #792 is an identity snapshot, **not approval**. Obtain a separate explicit owner approval for worker identity, key fingerprint, scope, expiry and signed package; atomically consume a unique nonce/grant with externally durable owner epoch and grant generation across competing Hubs. Provider down, stale proof, previous owner or reused nonce: **DENIED**.
4. **Pre-commit:** require independent *fresh* native witness of the exact installed bytes/import/file identity, worker principal/key, owner epoch, approved task root and package version floor. No broker service impersonation or generic elevated `windows-installer-job` fallback. Stop if a writer can still mutate any transitive loaded code.
5. **Install/update atomicity:** record an externally witnessed immutable operation before native cutover, then do protected staging and atomic switch as a future **explicitly authorized** worker-only operation. Preserve complete signed previous worker bytes for rollback. A signed older binary **below release floor** is still a downgrade and denied, even when its certificate is trusted.
6. **Crash/revoke/offline re-pair:** if effect may have happened and ACK was lost, return **RECONCILE_REQUIRED**. Never auto-replay, reissue a cloned requestId or assert `COMPLETED` from `pid exited`. Revoke-start fences new dispatch before stopping worker descendants; independently verify PID+creation time, key now unusable, signed old rollback hash, post-cutover handle/FileID, owner epoch increase and external receipt after reboot/disk rollback.
7. **Checkpoint boundary:** checkpoint metadata uses a strict allowlist of references, hashes, owner/worker epochs, `pendingUnknown` and receipt digests; *no* raw bearer/refresh, PKCS#8, private signing handles, command output, environment secrets or reusable signed approval. #08 owns actual content redaction/serialization tests. No worker restart from a stale metadata snapshot without native/external readback.
8. **Release claim:** `workerInstallAllowed:false`, `workerDispatchAllowed:false`, `brokerElevated:false`, `executionApproved:false`, `productionApproved:false` until independently signed protected worker installer, genuine restricted token, off-host admission and physical recovery acceptance all exist.

## 4. Minimum actual-source QA handoff, not another fixture suite

| Required future test | Concrete production API to target | Negative preserved | Owner |
| --- | --- | --- | --- |
| Current-user Agent SID == proposed coding worker SID | Real worker install preflight / native CreateProcess token | Deny if equal, even if package is signed; Job membership alone must not pass | #12 + #03/#36 |
| Authenticode trusted EXE, unsigned/transitively loaded DLL or writable updater/rollback ancestor | Native package/import/retained handle audit | Deny before staging and after startup/update readback | #12 + #05/#28 |
| Old signed worker binary and restored lower release floor | Native worker update and external signed monotonic version floor | `VERSION_DOWNGRADE_DENIED` (unless separately authorized recovery still respects floor) | #12 + #28/#587 |
| Duplicate worker signer SPKI / non-exportable claim from TEMP PKCS#8 | Distinct OS signer provider and native key protection API | Deny, no fallback to Agent or Broker key | #07/#13/#35; #12 integration |
| Concurrent enrollment nonce/revoke across two Hubs | Real external atomic admission writer | One winner at most; revoke-start beats uncommitted dispatch; lose ACK => UNKNOWN | #35/#01/#587 |
| Worker crash/restart/rollback with secret-laden checkpoint metadata | Real task checkpoint writer, never QA-only allowlist | Secret rejected; resume requires current epoch, verified effects and no replay | #34/#08/#01 |
| Physical adversarial cross-account process/file/network/handle check | Protected signed self-host staging environment, separate worker SID | Proven DENIED through native readback, not JSON or same-user TEMP fixture | #03/#16/#36 |

**#827 independent QA:** its 9/9 passing fixture tests establish useful *specification negatives* only. They must remain unchanged and be re-used against the **real provider** once available. A duplicated #12 Ed25519 TEMP fixture would not help.

## 5. Release blockers and scope

- #271: live legacy elevated import path inherits `Authenticated Users: Modify`; physical signed HIGH/CORE Broker remains **NO-GO** independently of any worker installer.
- #551/#617: genuine signed first-party protected installer, authorized local UAC, verified HIGH token/DPAPI and signed Agent 1.0.5 rollback are **not** accepted physically.
- #587/#588: no independently proven rollback-independent admission CAS and final mutation/artifact publication.
- #780: self-host worker **first**; cloud runner later with separate per-run signer and explicit budget. Existing Agent 1.0.5 remains unchanged.
- #12 must not modify #41 QA, #03 worker-process/Job, #07/#13 enrollment, #08 checkpoint, #05 sandbox, #28 rollback contracts or main. No live installer, service/UAC/Broker/ACL/DPAPI, Cloudflare D1/billing, actual user files, VM or ReVoltVPN-Ubuntu-Lab actions.

**Decision: PHYSICAL_PROVIDER_UNAVAILABLE / P0 NO-GO.** Source/spec acceptance delivered; **no actual new worker installer test is possible against a shipped worker installer API because it is not present in the reviewed code**.
