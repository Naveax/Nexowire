# #617 / #551 Hyper-V scoped Broker source trust acceptance (2026-10-21)

## Scope and strict non-goals

This #12 lifecycle extension is in the existing isolated #551 branch only.
PR #618 owns separate READ-ONLY tri-state user-facing privilege evidence;
this work does NOT edit its paths, start/stop a VM, execute arbitrary
PowerShell, wire a privileged Broker capability, elevate a token, change
UAC, touch production installers/ACLs or roll out to live devices.

The untrusted remote shell has Medium Windows integrity in the reported
Naveax observation. FULL/ROOT/CORE and running vmms/vmcompute do NOT prove
administrator, Hyper-V authorization or physical local Windows consent.

## New source-only trust contract

scripts/s3-hyperv-broker-trust.ts provides assessScopedBrokerTrust, a
pure evidence evaluation with injected native read-only binary evidence.
This is NOT a production runtime attestation provider.

The Broker manifest has an explicit role:
nexowire-scoped-hyperv-broker, a version and safe installed Agent/Hub
version interval, three distinct artifact SHA256 values for:
- Broker executable
- scoped Hyper-V helper executable
- installer/updater executable

A detached Ed25519 signature authenticates the canonical strict manifest.
The verifying public key must be pinned independently of the downloaded
release. Publisher Subject and Authenticode certificate DER SHA-256 MUST
match independent pins on each binary, not only the bundled Node runtime.
The actual broker running-image SHA256, creation identity, device scope,
verified OS image handle and authenticated health are separate evidence
requirements. A name, PID, port 401 or version string alone is insufficient.

A SECOND separately pinned Ed25519 public key authenticates owner
enrollment with exact owner ID, paired device ID, immutable VM GUID,
Broker version, monotonic owner authorization epoch and short bounded TTL.
Any wrong owner/device/VM, non-GUID target, expired approval, stale epoch,
forged signature or unsigned envelope is DENIED. The display VM name is
not an authorization key; a wildcard or command line is never executed.

ACL snapshot coverage is required for every binary path AND every
ancestor through the Windows drive root. This includes updater executable
and parent replacement paths, not just broker.exe. Deny inherited
Authenticated Users Modify, unauthorized writes, reparse nodes, missing
parent/updater, unsafe owner, arbitrary SIDs. The evidence snapshot does
not establish all dynamic import-graph ACLs or eliminate TOCTOU; P0 #271
independent actual privileged physical ACL acceptance remains mandatory.

A startup crash / journal rollback invokes isolated existing S3
crash-assessment, and is always fail-closed. Local journal/state is not
an independent monotonic authority. No automatic retry or rollback after
MUTATION_STATE_UNKNOWN: require independent authoritative VMId+state
reconciliation and external anti-rollback witness before any new request.

IMPORTANT: even fully valid synthetic evidence returns:
  status: source_verified_but_non_executable
  localPhysicalConsent: unverified
  executionApproved: false
  hypervStartStopEnabled: false
  productionApproved: false

An asserted remoteApproved=true is intentionally ignored. Real physical
local Windows approval cannot be provided by a request parameter or
Secure Desktop manipulation. No delegated generic elevated shell exists.

## Tests and independent evidence ledger

test/s3-hyperv-broker-trust.test.ts:
- Synthetic signed Broker and owner enrollment using DIFFERENT Ed25519 keys
- Manifest extra-field forgery, invalid role, wrong key and bad Agent version
- Scoped immutable VM GUID/owner/device, signature/TTL/epoch negative
- Broker/helper/updater independent signer, certificate and SHA256 faults
- Missing updater/parent ACL, inherited Modify, reparse/untrusted owner
- Trusted OS handle/image identity/health false-positive negative
- Startup crash with rollback/stale journal, no unsafe replay
- Forged remoteApproved=true cannot grant local physical Windows consent

Existing #551 tests additionally cover native Windows Authenticode read-only
against known signed OS and unsigned scratch EXEs, read-only real Windows
ACL rejection on USER-owned temporary folders, and staged signed
Agent/1.0.5 rollback fixture negatives. These do not prove an actual
Nexowire-signed first-party helper or isolated VM.

## Release NO-GO matrix

SOURCE: CI / strict TypeScript and fixture tests required at exact HEAD.
ISOLATED VM: real signed Broker package with independently pinned
manifest and helper/updater signers, actual protected ACL and parent
write-denial, owner-enrolled VM GUID, local physical approval, separate
VM start/stop consent, crash-on-start and hard reboot/rollback acceptance
NOT TESTED.

PRODUCTION: forbidden while #271 legacy ProgramData elevated runtime has
inherited Authenticated Users Modify; #551 has no independently signed
native installer/Broker helper and complete prior 1.0.5 rollback bundle
hash, trusted runtime handle attestation or external durable journal.
#617 Broker capability and #618 read-only evidence do not implement
permission to bypass Windows UAC. Both Work PC and Naveax stay Agent 1.0.5.
No Start-VM, Stop-VM, UAC changes, service restarts or Agent deployment.

Ownership: #04/#323 local consent grants; #03 trusted native helper and
ProcessManager; #02/#587 unknown/replay witness; #12/#551 signed binaries
and rollback; #16 independent physical QA; #00 final integration.
