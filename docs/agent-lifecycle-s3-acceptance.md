# Scale v2 S3: Agent lifecycle + safe onboarding acceptance (isolated)

Source: branch feat/parallel-12-agent-lifecycle-onboarding-20261018, based on
main 8bf7ce10972e78268e3cac945e833781b8d6846c. Scope: issue #485.

## Current truth and rollout gate

Two physically connected devices (Naveax and work-pc) advertised Native Agent
1.0.5 at initial inspection. This is **NOT evidence** that GitHub source HEAD,
installer, Hub or Agent on either host has been automatically updated.

The repository's existing nexowire.update.check/status/apply implementation is
in src/update/live-update.ts. It fetches tagged Windows Setup.cmd, archive and
a SHA256SUMS-Windows file from the same release, stages side-by-side and schedules
a PowerShell helper. Existing native Agent, Hub, Hub Boot and Broker task
lifecycle remain separate. A checksum file downloaded from the **same unsigned
release** does not establish Nexowire publisher identity or signed installer
provenance. The signed Node.js runtime is not a Nexowire-signed installer.

Do NOT call the existing production nexowire.update.apply from this PR. The
new strict S3 orchestrator in src/update/agent-lifecycle-manager.ts is a
dependency-injected acceptance kernel with no production execution adapter.
No installation, process stop, scheduled-task mutation, routing cutover or
background restart is introduced on Work PC or Naveax by this branch.

## Strict preflight and release trust

- Exact expected owner account + immutable device ID; never select by friendly
  device name or a single arbitrary online device.
- Explicit user permission before stopping an existing Agent; device-scoped lock
  acquired before preflight and released even on failure.
- Stable version syntax and signed manifest with strictly typed fields:
  version, source SHA, SHA-256, publisher, Agent/Hub min and max versions.
- Ed25519 manifest signature verified with a **separately pinned** trusted
  publisher public key, followed by artifact SHA-256. Independently verify
  Authenticode/publisher of the actual Windows binary and its digest. A
  caller-supplied publisher field or a self-signed artifact is not evidence.
  No trusted production Nexowire-owned signing key/certificate is bundled by
  this branch; without an operator-owned key + real signature verifier, updates
  MUST fail closed.
- Reject incompatible or older versions, low disk space, unknown owner/device,
  missing owner consent, signature failures and changed authority after stage.
- Never copy/update CORE grants, Admin Bridge status or ROOT/FULL permission
  as a privilege escalation; read and compare actual device-scoped authority
  before and after switch. Reject a changed owner/device/CORE/Broker/privilege.

## Version compatibility matrix

These bounds are **sample signed-manifest test fixtures**, not claims that real
binaries were certified against each other. The authoritative release manifest
must carry verified bounds and the staging acceptance test must prove them.

| Installed Agent | Existing Hub | Target Agent | Expected by fixture |
|---|---|---|---|
| 1.0.5 | 1.0.5 | 1.0.6 | compatible |
| 1.0.4 | 1.0.8 | 1.0.6 | compatible at boundary |
| 1.0.7 | 1.0.5 | 1.0.6 | reject unsupported/downgrade |
| 1.0.5 | 1.0.3 | 1.0.6 | reject Hub too old |
| 1.0.5 | 1.0.9 | 1.0.6 | reject Hub too new |
| 1.0.5 | 1.0.5 | 1.0.5 | reject replay/same version |

To accept real releases, run both Agent-old/Hub-new and Agent-new/Hub-old
two-device tests against built binaries and protocol negotiation. The test
fixture is not a substitute for this matrix.

## State transition contract

check -> explicit preflight -> acquire lock -> stage -> revalidate ownership ->
stop exact owned Agent -> atomic cutover -> start exact owned Agent ->
health/version/owner/device/grants verification -> succeeded.

A network outage while checking persists failed with UPDATE_CHECK_FAILED,
rather than leaving a stuck "checking" state. Stage or ownership failures
occur **before** a service stop. Once stop has begun, any error triggers
best-effort restoration of the prior runtime and independent health proof:
rolled_back only when identity/version/Hub/authority all match the original.
Otherwise rollback_unconfirmed. Never report success based on a PID alone.

The injected adapter MUST implement atomic process ownership, protected
launcher/installer destinations and durable cross-process mutexes before
connecting to the live updater. Existing PowerShell script's generic TCP-port
health test and task-name checks are insufficient evidence of exact ownership.
Reconciliation after host reboot requires a persisted transaction journal and
signed rollback target, which are NOT supplied by this PR.

## One visible "Yeni cihaz bağla" entry point

The existing dashboard links to /connect.html. It provides OS-specific release
downloads, GitHub account sign-in, owner approval, device-id-bound pairing and a
DPAPI-protected device credential on Windows. This PR changes the sensitive
pairing callback from query string to a form POST on exact 127.0.0.1 and
origin-locked loopback receiver. Short-lived nonce/state and per-device identity
remain required. No credential is sent via URL/history/argv.

The current experience still requires installer execution/verification by
the device owner. A fully signed first-party, UAC-consensual, one-click
installer with real progress/cancellation, automatic signature verification,
repair/uninstall and physical clean-user VM acceptance is a **remaining
release blocker**, NOT silently advertised as complete. Do not automatically
stop existing devices while pairing a new one.

## Isolated evidence and remaining checks

- test/agent-lifecycle-manager.test.ts: signature/hash, publisher, version
  matrix, owner/device/space/consent, rollback and failed rollback states.
- test/connect.test.ts / test/connect-web.test.ts: real loopback POST path,
  rejected URL GET/invalid Origin/wrong state and Windows DPAPI enroll test.
- test/live-update.test.ts: offline check persisted failure.
- TypeScript typecheck and build plus targeted tests must pass on this branch.
- Physical sign/release/build provenance: pending #269.
- Real two-device install/update/rollback acceptance, Windows clean-user
  non-admin/UAC/AV tests, offline/captive portal/restart/repair/uninstall,
  restart-safe journal and long soak: pending.
- No merge to main, live Agent or Broker restart, scheduled task invocation,
  production route mutations, or paid Cloudflare changes authorized.


## Continuation: native Windows signature inspection and CI regression

The first PR CI run 39135168316 failed in test/console-ui-polish.test.ts
because an old static assertion still expected the now-removed callback query
redirect. The source change remains form POST. The test now explicitly
requires the POST method and rejects putting the pairing credential in URL
parameters. This prevents a regression toward token-in-query.

scripts/s3-windows-binary-trust.ts performs a **read-only**, operator-invoked
acceptance inspection (NOT imported by the Native Agent runtime) against
a caller-provided Windows disk FILE: exact SHA-256, Windows Authenticode
SignatureStatus.Valid, exact certificate DER SHA-256 pin, exact publisher
Subject, and before/after file hashes. Every path ancestor must be an ordinary
non-reparse path. It launches a fixed Windows System32 PowerShell executable
with no profile, no shell and a restricted PATH/module environment. It
returns safeToExecute=false and productionModified=false, even on success.
This is proof of the selected disk file's signature at inspection time, not
proof of which bytes a subsequent installer will execute.

A standalone read-only operator diagnostic is available:

    npm run s3:verify-windows-binary -- --file "C:\staging\Nexowire-Agent.exe" --sha256 <sha256> --cert-sha256 <cert-der-sha256> --subject "CN=Exact Trusted Publisher"

**Critical:** these inputs are pins, not a trust-root discovery service.
Production pins must be independently provisioned by the owner/release signing
pipeline and must NOT be learned from the untrusted downloaded binary or
checksum manifest. The native test uses a Microsoft-signed notepad.exe as a
known OS test file only: it does not claim Microsoft (or signed Node) is an
authorized Nexowire publisher. Tests also reject unsigned bytes, changed
signed bytes with matching rewritten SHA-256, wrong publisher, wrong
certificate and wrong file hash.

To wire the strict trust gate to production, there must first be a signed,
published Nexowire-owned installer/Agent binary, immutable operator key/cert
pins from an authenticated channel, protected stage/rollback paths,
a journal that survives process/OS crash and a clean-user VM approval gate.
Any unsigned Setup.cmd plus archive checksum alone remains insufficient.

Existing live Windows Agent v1.0.5 tasks, Hub and Broker were intentionally
left untouched. No auto-restart, live nexowire.update.apply, production
service mutation or main merge is part of this continuation.
