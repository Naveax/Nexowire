# Six-gate CORE source integration candidate

This candidate combines exact source parents without changing main or the
owner branches. It does not install or enable CORE on either PC.

| Gate | Concrete source/CI work | Remaining production requirement |
|---|---|---|
| Native owner approval | #962 freezes consent scope/signing pin; #964 supplies a real Windows WebAuthn assertion component and independent ES256 verifier, with explicit one-use consume boundary | Protected signed service/IPC; real credential registration/attestation and owner-SID provisioning; durable receipt consume and independent native readback; current-logon delegation of persistent owner approval |
| External CAS | #963 implements PostgreSQL reserve/commit/release and generation-advancing revoke/drain; real PostgreSQL tests include actual test-container restart and UUID retention | Independently operated hosting/restore controller, protected TLS/service/signing credentials, native Broker/drain witnesses and physical rollback/failover acceptance |
| Publisher and rollback | #966 verifies domain-separated signed complete payload manifests, exact source/entrypoint, release parent/sequence and file identities | Actual Nexowire publication/signing custody, Authenticode/installer chain, protected external release anchor and atomic acceptance, installed ACL/held-image/token verification |
| Task isolation | #965 compiles and runs a fixed AppContainer/Job/token/handle/canary/loopback/descendant diagnostic on a disposable Windows runner | Production protected worker; complete WFP/DNS/IPv6/COM/IPC/private-desktop and artifact isolation; real revoke/UNKNOWN handling and two-PC containment acceptance |
| Source integration | The two exact parents below are combined in an isolated detached worktree; only independent workflow sections merge | Exact combined-head CI, owner review and a separately authorized protected staged release; no main integration performed here |
| Physical acceptance | CI distinguishes software fixtures, real disposable PostgreSQL, read-only Windows API probes and fixed native diagnostic outcomes | Actual installed two-device enrollment/revoke/restart/soak and external-authority co-rollback/lost-ACK/failover tests; no skip/fixture may satisfy these gates |

## Exact parent custody

1. Manifest/native branch #966:
   `6936180dd9f20faccc183aea8b60d9d449763e63`, preserving
   #965 `18f169538d732022112b421c48fccb86e58b319b`,
   #964 `286a4ac8990d5b6f1f561affe4996040cd8a6cf6`,
   #962 `e9be2d522c0042353badd7e9c3be6a7ceead8665`,
   and #961 `c853b733ef1abfb0c937d6b3135ea112887daed9`.
2. PostgreSQL branch #963:
   `3a43e3bbd8416a48c19f333dedebd49289cc1d66`, preserving its
   initial `2d94909d7980a0d50d01019eb7ddaef8d94e5b4c` and common #962 parent.

The only overlapping path is `.github/workflows/ci.yml`: one parent adds early
bounded Windows native/manifest steps, the other adds the Linux PostgreSQL
service and transaction/restart steps. Both are retained without dropping prior
jobs, checks or source assertions. Other PostgreSQL paths are exact parent
blobs. No existing commit is rewritten, reverted or force-pushed.

## Evidence interpretation

#963's first CI `40877720261` is historical RED, not rerun: its newly introduced
release-ACK assertion incorrectly conflated a known completed mutation with a
lost ledger-release ACK. The follow-up retains that known result while
requiring same/new requests to be fenced and original UUID replay to remain
denied. No production fence or existing assertion was changed. Current exact
#963 CI is `40907202739`; its real PostgreSQL/restart step is source/storage
integration evidence, not independent production custody or native drain.

#962 exact-head CI `40875682819` completed seven successful jobs. Each later
head has its own first automatic run; these results must not be transferred
to another SHA, merge tree, workflow or physical device. Current job/log
evidence belongs in PR metadata, not a self-referential generated source SHA.

The original uploaded Broker ZIP is not executed, republished as a signed
installer or changed. No actual server, credential, certificate, Windows Hello
decision, HIGH token, ACL, enrollment or device acceptance is fabricated.

CORE duration remains indefinite/revocable (`expiresAt=null`).
`CORE_EXECUTOR_DISPATCH_ENABLED=false`, the #07 production worker remains
deny-only, and missing native enrollment still returns
`LOCAL_ENROLLMENT_REQUIRED`. UNKNOWN/STOP/tombstones are never cleared to make
the status look active. No live Agent, Broker, service, UAC, ACL, VM, main
merge, ready/base retarget, production release or deployment is performed.
