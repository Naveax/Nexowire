# NX AI-03 production authority provisioning and independent acceptance

Review base: d175874b1282c43bab45d3aa1327cbceacabbd1e (coord/final-release-fanin-20261125 at review). This is an operator approval checklist, not permission to deploy or enable a privileged effect. No live systems, production credentials, issuer installation, or key generation are performed. CORE_EXECUTOR_DISPATCH_ENABLED remains false.

## 1. Existing implementation and gap inventory

| Boundary | Existing production source | Missing production evidence |
|---|---|---|
| Native completion/drain verification | src/agent/protected-native-completion-reader.ts (b6f6c298ee0863064942fa4d8dbb4847b22965d6) | Independently installed OS observer, reviewed capability evidence policy, actual signing custody and provenance |
| Dispatch authority | src/agent/protected-broker-dispatch-service.ts (eb29ce4ea890accc7fbdc84912852eb889d4e3d0), postgres-broker-dispatch-authority.ts | Provisioned restricted database roles, independent restore witness, real scoped Broker readback and revocation verifier |
| Local approval | src/security/protected-owner-consent-authority.ts (a7f1ad35ff6757b76a3c253e4d20217ceb33763f), postgres-core-approval-ledger.ts (13c1cf64080548e1d1ace9f8aeb84c5fefb4053e) | Independently provisioned Windows owner directory and real local Windows Hello consent/receipt issuer |
| Hosted verifier | src/security/core-native-enrollment-verifier-handler.ts (704a4b6a0b46c718cb6c7c413ffb92aac39d551a) | Authenticated service deployment and protected issuer binding; cloudflare/worker.js:745 currently constructs D1CoreConsoleAuthority(env.DB) without nativeEnrollmentVerifier |
| Native admission | src/agent/native-atomic-effect-admission.ts, protected-transfer-startup.ts | Actual external TrustedNativeMutationProvider; approved capability-specific native admission and observer; no generic executor provider |
| AI-02 recovery | src/security/protected-helper-rollback-guard.ts (bb298c736a74951807427595a0990b16def2061b) | Independent recovery issuer, protected writer fence, reviewed immutable runtime and durable baseline |
| Windows owner launcher | #1314/#1319/#1329 existing source deliveries | native/windows-core-owner-launcher.c and src/security/windows-protected-owner-issuer.ts not present at reviewed coordinator SHA; coordinator must review exact source and signed install independently, not silently import or treat prior build as production |

The existing verifier verifies signatures, identity and evidence kind. It does not make the evidence true. D1 APPLIED means database mutation only. SQL row counts, a process exit, local DPAPI key, timeout, successful TLS, test signer and fixture callback are insufficient as independent proof.

## 2. Required services and owners

| Service / boundary | Responsible owner | Provisioning input / approval evidence |
|---|---|---|
| Isolated Windows acceptance machine | AI-09 / device owner | Explicit device-owner permission; disposable VM or dedicated nonproduction device; signed pinned image and clean restore procedure; no production files, accounts, credentials or installed task changes |
| Independent OS observer | Security/operator | Approved exact image and installation identity; separate service identity and protected read-only observation source; independent access to actual OS evidence; no public arbitrary command/effect endpoint; signed attestations scoped to approved capability and request |
| Independent consent authority | Security/operator + physical owner | Pre-reviewed owner/device/installation binding, Windows SID and credential registration, active unlocked logon and fresh local human ceremony. Pairing, D1 preference, Broker readiness or an owner identity supplied by caller is not consent. No remote approval substitute. |
| Protected dispatch service | Authority operator | Reviewed exact source and runtime, private endpoint with TLS 1.3 mutual authentication; restricted runtime DB identity, externally maintained live provenance and independent owner revocation/observer callbacks. Existing startup must deny missing provider or invalid policy. |
| PostgreSQL durable history / restore witness | DB operator + independent witness owner | Explicit reviewed migrations (core dispatch/credentials/native completion and existing approval ledger), separate runtime/observer/operator identities, restore continuity evidence outside the restorable database. Runtime cannot create grants, change observer pin or insert/delete completion history. Observer cannot alter grants/claims. No credential or schema fallback. |
| D1 hosted consent verifier | Control-plane operator | Dedicated authenticated integration with protected issuer and durable consume/readback. Existing Worker has no configured native verifier; positive CORE stays unavailable. No synthetic verifier binding. |
| AI-02 recovery authority | Separate recovery operator | Separate signing identity, approved baseline and physical writer-fence/readback proof; unresolved operations or pending recovery deny. CORE drain never authorizes rollback, cutover or deployment. |

All identities, account names, endpoints, key references, public pins, certificates, issuer policy revisions, exact image/source hashes and approval receipts must come from authorized operator provisioning. Do not put credentials in this document, source, chat, fixtures, environment dumps, or CI artifacts. Missing assignment or evidence is BLOCKED, not a default value.

## 3. Trust roots and signing custody

Maintain distinct purpose-bound signing and authentication trust: release Authenticode/code-signing trust, transport CA and client identity, dispatch permit signing, independent CORE native observer, helper evidence, AI-02 recovery, and owner WebAuthn registration. The recovery public key must not equal CORE dispatch or observer or helper observer SPKI; observer inputs are public-only PEM. Distinct SPKI alone proves neither service independence nor custody.

Custody requires an approved hardware-backed or independently isolated signing service whose algorithm and key protection are actually verified; Ed25519 support must be confirmed for the selected provider, not assumed from TPM presence. Operator attests non-exportability where required, least-privilege access, independent administrators, audit, issuance policy, key rotation/revocation and restore behavior. Do not export the observer/recovery private key into dispatch/Hub/Agent or reuse a TLS/release/fixture private key for evidence. Current dispatch startup accepts privateKeyPem; that is process-held key material, not proof of hardware-backed non-exportability. If the selected custody requires an external signer, the existing signing integration requires a separately approved adaptation and acceptance; do not claim current PEM path implements it. Pin reviewed public keys and policy from the independent source; rotation requires reviewed new trust state, never trust a key embedded in a reply.

## 4. Capability-specific acceptance policy

Start with no production capability admitted. For each existing approved capability, an operator-reviewed evidence contract is needed: exact capability identifier, canonical effect fingerprint, immutable request/dispatch/commit nonce, owner/device/installation/session and authorization generation, actual OS target identity, pre/post state source, terminal observation, evidence digest, and no-replay/unknown handling. Observe only disposable/inert targets for acceptance. Job-object evidence describes only the exact contained operation and verified terminal containment; a generic job/process exit cannot establish terminality for a different OS effect. A readback of unrelated object or an operation ACK is not a native completion. Do not map all capabilities to one generic observation kind. Capabilities without an independent effect-specific observation remain denied.

The current existing reader accepts JOB_OBJECT_EMPTY and NATIVE_OPERATION_TERMINAL only under a configured exact capability policy. Neither enum is a positive native witness. The actual observer, permanent fence and its signing origin remain unprovisioned. No new privileged capability or execution adapter is introduced by this review.

## 5. Atomicity and revocation acceptance

Use the existing external durable claims, immutable signed completion history and revocation state machine as the control-plane contract. Actual native effect admission still needs an independently enforced boundary that cannot be bypassed by a stale permit, process restart, lost acknowledgement, or a concurrent revoke. Database commit alone is not atomic with an OS effect. A local JS callback, local mutex, deadline, or a signed request cannot close that gap. Review the real native boundary and prove the exact request never re-executes and no unverified terminal claim is released. If OS outcome is ambiguous, retain UNKNOWN, original request identity and containment/recovery fence. Revoke ACK is not OS drain. The local pendingDispatch marker is retained after revoke and no replacement enrollment clears it without an independent recovery path. This local safeguard is not cross-process atomic storage or restore-proof history. No clearing API is provided. Do not manually remove the marker or infer a clean state from it being absent. External authority and approved recovery proof remain mandatory.

## 6. Staged acceptance gates (no deployment authorized here)

1. **Source review:** AI-00 selects exact candidate and reconciles provenance; AI-08 validates changed source and existing canonical fixtures without weakening counts. No duplicate workflow dispatch.
2. **Operator provisioning review:** independent service identities, public pins, approved signed artifacts, verified separate custody, restricted database roles, fresh provenance and owner enrollment binding. Reject same key, wrong signer, uninstalled/unsigned image and unavailable observer. Only public pin digests and redacted evidence IDs in report.
3. **Read-only native observation:** AI-09 on dedicated authorized isolated device. Verify actual identity, containment/terminal observation and stale/restarted/wrong-object denial; missing access means BLOCKED. No live-host experiment.
4. **Human ceremony:** actual owner physically present; accept only the approved local ceremony, exact session/identity and durable single consume. Test rejection of cancel, lock, stale session, replay and owner mismatch. No remote UAC/Hello approval.
5. **Inert capability acceptance:** per approved isolated capability, actual independent observation, scoped signature, ACK loss, concurrent revoke/dispatch, reboot/restart, stale generation, duplicate admission and observer failure. UNKNOWN must retain original marker, deny replay/renewal/release. Do not execute unrelated or broad privileged operations.
6. **AI-02 recovery:** separate issuer and independently signed recovery state, writer fence and immutable baseline; no release from CORE drain or local stop. Review AI-02 specific denial path and physical proof separately.
7. **Release:** coordinator exact-head software acceptance plus independent physical evidence, operator security review and explicit user decision. This document supplies no release authorization. CORE_EXECUTOR_DISPATCH_ENABLED stays false.

## 7. Status and evidence handoff

SOURCE_HARDENED: composed key separation and local unresolved-marker retention; focused negative tests supplied, exact hosted acceptance pending at delivery. Existing verifier and durable CAS untouched. BLOCKED: actual installed independent OS observer, capability-specific native acceptance, real owner issuer/ceremony, verified key custody, external atomic OS boundary, independent AI-02 recovery proof. No test key, synthetic callback or local process closure is production evidence. No production positive claim or automated recovery fallback.
