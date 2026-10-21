# Nexowire #12 / #551 child: CORE Broker bootstrap, DPAPI and delegated-command source acceptance
21 October 2026 | child branch: feat/12-core-bootstrap-delegation-20261021

## Intended Windows privilege model, not present live capability

An authorized Windows owner approves a *first-party Authenticode signed* protected installer through the OS-managed local UAC flow exactly ONCE to enroll a Broker. The Broker is registered with a protected Windows Task Scheduler identity and runs with a genuinely elevated effective Windows token, a privileged identity that ordinary Medium user processes cannot replace or impersonate. CORE can subsequently delegate individually authorized administrative commands to the already-running protected Broker without presenting new UAC prompts *per command*. This is not elevation of Medium shell.exec, a Secure Desktop clicker, a generic privileged command dispatcher, or a silent UAC bypass.

A physical installer must pin the exact signed native Broker/helper/updater/old rollback tree, protect all parent paths and imported binaries and owner delegation material, atomically commit an owner-scoped task, prove actual elevated effective token and running image handle, and retain independently durable rollback/revoke information. The signed owner policy and per-command request are separate from the Windows local install consent receipt. No user-supplied approved:true bit grants the physical approval.

## Source-only child module and evidence

scripts/s3-core-bootstrap-delegation-audit.ts adds:
- Separately pinned Ed25519 owner enrollment and command verifying public keys. Strict signed canonical records bind owner ID, device ID, enrollment epoch, initial installer transaction, Broker binary and updater SHA-256, DPAPI blob digest, Task Scheduler task identity and installation time. Per-command signed intent binds CORE capability, input hash, unique request ID and an independently observed minimum sequence. An unsigned string containing a shell command is not privileged authority.
- Source readback of a protected Windows Task Scheduler record: exact \Nexowire\PrivilegedBroker task name, running state, SYSTEM (S-1-5-18) service-account principal, highest run level, signed action binary hash, publisher/certificate, verified native Windows high/elevated token with enabled/non-deny-only Administrators, independently identified running process image and creation identity.
- Source readback of an owner-bound DPAPI CurrentUser blob protected under the SYSTEM identity, encrypted blob SHA-256, owner/device/Broker/epoch binding, protected Broker unseal proof, no export to a Medium caller. DPAPI LocalMachine without effective ACL protection is NOT equivalent to these requirements. This module NEVER calls CryptUnprotectData or reads any live secret.
- Conservative inherited/explicit NTFS ACL examination of Broker executable, updater, imported DLL and DPAPI blob with every directory ancestor; fail closed on Authenticated Users Modify, replacement parents, untrusted owners, reparse points, unknown files or incomplete import inventory.
- Old signed rollback and external journal witness check; unknown mutation or wrong post-rollback running image cannot auto-replay. Independent revoke ledger must advance epoch; stopping requires trusted stopped readback, revoking requires trusted disabled/deleted task readback AND DPAPI key inaccessibility.

A synthetic full PASS explicitly returns:
  status: source_only_not_deployed
  initialUac: one_local_os_approval_required_for_actual_install
  perCommandUac: not_required_only_after_real_broker_acceptance
  elevatedCommandMayExecute: false
  productionAccepted: false

A stopped/revoked synthetic fixture returns commandAllowed:false. This contract intentionally does not install a task, launch Broker, unwrap owner secrets, dispatch shell commands, change UAC/ACL, manipulate a VM, or grant elevated rights.

## Scope of negative source tests

test/s3-core-bootstrap-delegation-audit.test.ts includes 10 top-level test suites with multiple negative variations for:
1. Signed bootstrap and second signed command without execution authority
2. Forged owner key, wrong owner/device, old enrollment or replayed transaction
3. Failed, pending, remote-UI or consent.exe-only UAC approval
4. Wrong Task Scheduler principal, executable, Publisher, task RunLevel or process token/image
5. Incorrect DPAPI scope/SID/blob/owner/Broker/epoch and Medium-caller export
6. Writable/missing/reparse parent, updater, imported image or DPAPI blob
7. Replayed/stale/wrong-owner signed CORE requests and unsigned shell-bypass fields
8. Bad rollback, UNKNOWN cutover, missing durable external journal or owner revocation
9. Stop not independently observed while Broker remains running or UNKNOWN
10. Revoke without higher independent owner epoch, task disabling/deletion and key inaccessibility

These synthetic OS records are **not native Windows OS evidence**. Real DPAPI under protected service identity, signed first-party installer, task registration ACL and high-token process attestation remain untested. Do not treat source acceptance as deployment proof.

## Dependencies and production gates

Parent PR #551 is the source-only Agent Lifecycle signed installer/rollback and one-time consent model; this child targets #551's own feature branch, not main. PR #618 is the independently owned read-only Windows admin evidence contract. #617 records that the desired CORE flow is one local OS UAC approval at initial trusted Broker enrollment followed by no per-command UAC for properly authenticated CORE operations; ROOT is the time-limited owner grant, not a way to bypass OS consent. #03 owns real native Broker/process capability dispatch and #04/#323 owns owner authorization and local approval provenance. #587 needs an independently durable monotonic anti-replay authority, #16 handles independent Windows QA.

**Hard NO-GO: #271 remains open** because actual elevated legacy NexowireStack ProgramData code has inherited Authenticated Users Modify. Other absent proofs: first-party Authenticode signed native installer, complete signed Agent 1.0.5 rollback archive and snapshot/crash acceptance, actual protected parent/import/updater ACL with tested effective write denial, real OS-owned UAC grant, native DPAPI/task high-token attestation, and an independently monotonic revoke/stop ledger. No live Agent/Broker/service restart, UAC or ACL edits, Start-VM/Stop-VM or deployment of #596/#608.
