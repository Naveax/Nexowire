# Nexowire CORE / ROOT execution paradigm, 21 October 2026

**Owner product decision:** CORE means persistent, broad, genuine Windows
administrative authority once a trusted elevated Broker is installed with
visible local Windows UAC consent. ROOT has **the same broad elevated
operation set** for one owner-bound login with a maximum 15-minute grant.
FULL grants broad *standard-user* actions. SAFE remains bounded.

**This branch implements source-only candidate protocol, D1 staging
persistence and truth-oriented UI. It does NOT deploy elevated authority.**
No Windows service, token, Agent, UAC, Hyper-V VM or production D1 changed.

## Capabilities and consent

| Mode | Desired runtime when physically authorized | Repeat UAC? |
|---|---|---|
| SAFE | Bounded user-level work | Not applicable |
| FULL | Broad ordinary-user shell/files/process work | Cannot acquire elevated rights |
| ROOT | Signed protected elevated Broker: shell, PowerShell, files, registry, services, processes, Hyper-V, 15 minutes max | No, during its verified grant |
| CORE | Same broad elevated Broker, durable delegated owner/device enrollment, explicit revoke | No, after one approved bootstrap |

No static VM GUID allowlist is imposed on generalized CORE/ROOT shell work.
A typed Hyper-V GUID API remains useful for independently verified
postconditions and safely structured operations. Delegation does not
override Windows OS integrity, provider policies or commands the owner
has not authorized, and does not imply license to bypass UAC, Secure Desktop,
other people's accounts or OpenAI/third-party safety limits.

## Enrollment and execution authority separation

1. Operator intentionally installs signed Broker through **normal Windows UAC
   visible local approval once**, with pinned publisher, immutable executable
   and helper/import/update tree, protected parent ACL, rollback manifest,
   task identity and protected local key custody.
2. A protected native observer attests enabled high-integrity administrator
   token and exact image/task identity, not Agent-reported `brokerReady`
   and not unauthenticated 43112 `/health` 401. Any missing token/ACL proof
   is BLOCKED, not automatically rescued by CORE preference.
3. A pinned Ed25519 signer produces a short-lived owner+device+credential
   epoch+Broker SHA/version local bootstrap transcript after physical UAC.
   `verifyCoreBootstrapCandidate` verifies cryptographic source evidence;
   without independent native facts it rejects. The returned object is
   explicitly **not a production OS privilege token**.
4. D1 migration `0020_core_admin_delegations.sql` adds device-scoped
   enrollment generation + revocation timestamp and separate append-only
   consumed enrollment IDs. SQLite/D1 triggers permanently revoke a grant
   on CORE preference OFF/deletion, SAFE mode, re-pair, owner change or
   Broker mode removal; simply switching a preference back ON cannot revive
   old signed enrollment. `D1CoreDelegationLedger` uses atomic SQLite/D1
   transaction with CAS generation and replay blocking. Owner/device pairing,
   broker image/version, SAFE, revoke and credential change deny candidate
   lookup; reconnect itself does not destroy an enrollment.
5. Every elevated operation still requires *fresh authenticated owner session
   scope* and an independently attested, protected Broker, even though
   persistent CORE enrollment survives a connection loss. An expired
   session cannot execute. A real owner revoke must invalidate the local
   protected Broker capability as well as the D1 record before any future
   executor accepts a request. D1 alone cannot make a local cached
   token safely revocable if disconnected: this is a deployment blocker
   until independent monotonic local/remote CAS (#587) is operational.
6. ROOT uses the same broad operation categories but requires the current
   login-bound 15-minute lease. After expiry, deny. CORE uses the durable
   enrollment and does not require a new per-command UAC dialog.
7. `explainBroadAdminDelegation` classifies general
   `admin.shell`, `admin.powershell`, `admin.filesystem`,
   `admin.registry`, `admin.service`, `admin.process` and
   `admin.hyperv`. It **never directly dispatches** anything, and a
   synthetic fully trusted scenario is only `DELEGATION_CANDIDATE` with
   `canDispatch:false`. Provider policy still applies independently.
   UNKNOWN may have side effects; reconcile first and never auto-replay.
8. UI distinguishes persistent CORE **selected** from CORE **effective**.
   It never treats `persistentMaintenance.active` or broker telemetry
   as proof. No effective CORE is surfaced absent independently
   validated protected local enrollment, high token, ACL and Broker version.

## Tested, not accepted

- SQLite-based real D1 migration, owner/device enrollment, durable restart
  readback, revocation, replay, generation rotation, re-pair and SAFE negatives.
- Signed Ed25519 bootstrap candidate and native Broker token source receipt
  tests covering forged consent claim, stale signer/image/version, medium
  integrity and deny-only Administrators.
- Broad CORE shell/service/registry/PowerShell/Hyper-V privilege category
  candidate tests and ROOT 15-minute expiry, provider policy and UNKNOWN
  state no-replay tests.
- UI truth regression guards.

**Physical BLOCKERS (NO-GO):** #271 Naveax ProgramData NexowireStack
and `cli.js` authenticated users inherited Modify, protected Broker ACL
unreadable; #551 first-party signed installer and trusted rollback not
accepted; #260 version-attested Broker/native high token not accepted;
#323 real local protected signed consent and delegator not installed;
#587 independent monotonic revocation witness not accepted.
Cross-PR #618 is only a read-only diagnostic and must not be mistaken
for an executor. Any successful source unit test or cloud CI remains
SOURCE-ONLY, not proof that a privileged shell command ran.

**Worktree:** `feat/04-core-delegation-617` branched from PR #574 head
`2adf0e29fd41914a842cafd7fdadef25d24da103`; child DRAFT PR should
target this parent branch rather than blindly rewrite #574 or main.
