# Nexowire #16 — Independent QA MASTER, 21 October 2026

**Pinned main:** 4c5c810134c020cd04a5ef2be5c1138ea1954ad0 (main source CI 39596766086 SUCCESS). **QA PR:** #572 DRAFT, source-only; no main merge or live VM/UAC/Agent/ACL mutation. **Production: NO-GO.**

## The actual owner CORE acceptance target

- **FULL:** wide standard-user action scope. It is not implicitly elevated.
- **ROOT:** real broad Windows high-integrity administrative command delegation, owner/session/device-bound and limited to **900 seconds (15 minutes)** with expiry, logout/re-pair/revoke and stale epoch enforced by authenticated Broker/witness.
- **CORE:** real broad Windows high-integrity administrative shell/process and typed administration, persistent until explicit owner revocation, not SAFE/VM-only. Signed protected Broker is bootstrapped after one genuine local Windows UAC consent, and later authorized CORE commands do not demand a fresh UAC prompt per command.
- The above requires signed owner/device/session/CORE epoch proof on every elevated dispatch, local token and protected executable/import/ancestor ACL attestation, independent monotonic replay authority and revocation. CORE preference alone is not execution authority; no remote secure-desktop click/bypass.

## Actual source-negative results on current main

- test/qa-core-broker-p0-negative.test.ts: **5 PASS / 3 intentionally RED / 0 SKIP**. RED: ROOT diagnostic reports an unbounded expiry without authenticated issue timestamp; no separately elevated windows.elevated.shell.exec capability; no registered independently authorized high-Broker dispatch.
- Existing test/qa-hyperv-617-source-negative.test.ts: **5 PASS / 2 RED** for typed Hyper-V privilege/elevated Broker registration on main.
- The older stale SQLite snapshot and one-call transfer RED source contracts stay intact, active in a separate CI job with no continue-on-error, test.skip, retries or superficial PASS.
- QA metadata release/traceability suite **35/35 PASS** on local isolated QA worktree, 0 SKIP; typecheck/build/continuation/diff check PASS. This validates the inventory/truthfulness, NOT the missing elevated runtime.

## Exact head CI provenance at inspected SHAs

| PR | HEAD | CI | Outcome / caveat |
|---|---|---|---|
| #618 | 512a1764d65e | 39605003581 | FAIL — browser-live Windows Job fast-exit iteration 4 |
| #619 | 6f6c2b3812af | 39604390404 | PASS — Old #618 base 14d0d6; source success does not apply to latest #618 |
| #620 | 4ba879f591d1 | 39604898508 | FAIL — Windows Authenticode surrogate and disposable parent Modify ACL tests fail, typed dispatch OFF |
| #576 | a3946c1f25b8 | 39598258315 | FAIL — Real Authenticode surrogate UNAVAILABLE and inherited Modify ACL detector null; historical green cannot override current red |
| #608 | d34c0d3c85bc | 39503650650 | PASS — Combined old #576 Job+#598 HTTP, Release 39503650638 green, unsigned production |
| #614 | ef1e3b23b013 | 39598693419 | PASS — Synthetic PostgreSQL contract+signed provenance, no real external independent storage |
| #616 | 94b92e01219a | 39598755514 | PASS — CrossHub source adapter 1GiB physical signed two device unverified |
| #609 | fd54719ae706 | 39596941696 | PASS — #599 errors combined with old #576 Job source; not latest parent |
| #610 | 3064acdf18b0 | 39597505104 | PASS — Synthetic cancellation receipt, no real Cloudflare staging |
| #612 | ed7b6a9638fd | 39597637188 | PASS — Async signed device enrollment source race fixed, no production |
| #613 | d019e99efd46 | 39598086598 | PASS — Owner epoch checkpoint source verified, no live Agent disconnect |
| #615 | a1c65587730a | 39598738701 | PASS — S5 9.5MiB gzip and local fairness source only |
| #551 | 9fdee36897de | 39606595530 | PASS — Latest exact-head CI 39606595530 and Release Readiness 39606595531 SUCCESS only for source, signed first-party installer, actual high token, signed rollback and VM/two-agent physical acceptance still BLOCKED |
| #572 | 99df8e60a2a7 | 39604979439 | FAIL — Historical QA CI browser-live durable READY and intentional red source assertions |

CRITICAL: #618 source-only CORE intention HEAD CI fails Windows Job stdout-before-exited (iteration 4); #620 fails two Windows Authenticode/ACL fixture assertions; latest #576 HEAD fails signed OS surrogate + inherited Modify fixture, despite older #608 green source. #619 is green on a **different, older #618 base**. #614 external PostgreSQL witness is currently a synthetic SQL adapter, not an independently operating external DB.

## Four-stage R01–R22 exact source snapshot

Source: 6 PASS / 6 FAIL / 9 BLOCKED / 1 NOT_TESTED. **All 22 staging, production and original incident rows remain BLOCKED.**

| R | Source | Staging | Production | Original incident |
|---|---|---|---|---|
| R01 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R02 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R03 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R04 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R05 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R06 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R07 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R08 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R09 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R10 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R11 | NOT_TESTED | BLOCKED | BLOCKED | BLOCKED |
| R12 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R13 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R14 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R15 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R16 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R17 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R18 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R19 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R20 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R21 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R22 | FAIL | BLOCKED | BLOCKED | BLOCKED |

## CORE master release contract (14 negative and acceptance gates)

| Gate | Requirements | Source status | Physical gate |
|---|---|---|---|
| ROOT_15MIN | R04, R22 | MAIN_FAIL | Source diagnostic permits leaseUnexpired on a reported expiry 901s ahead without a signed issuedAt; diagnostic policyActive remains false, no elevation occurred |
| CORE_PERSISTENT | R04, R19 | MAIN_FAIL | Main has no explicit elevated Broker shell endpoint; CORE preference returns PAUSED_UNVERIFIED |
| FULL_STANDARD | R04, R07 | SOURCE_PASS | Current generic shell exec standard, excluded from privileged Broker |
| ONE_TIME_UAC_BOOTSTRAP | R04, R19 | BLOCKED | Installer trust source-only; never saw signed first-party installer or physical UAC/VM canary |
| SIGNED_ACL_IDENTITY | R04, R19, R22 | PHYSICAL_FAIL | #271 actual Naveax legacy executable inherited Authenticated Users:(I)(M), Broker protected ACL inaccessible |
| OWNER_REVOKE_REPAIR | R02, R04, R20 | BLOCKED | #614 external witness SQL synthetic, no physically trusted independent post-restore and signer migration |
| LOST_ACK_NO_REPLAY | R01, R02, R20 | BLOCKED | #587 simultaneous J+A rollback re-admits historical requestId; #619 old parent pure source negative CI green only |
| SIGNED_BROKER_WIDE_SHELL | R04, R07, R22 | MAIN_FAIL | No registered explicit elevated shell capability on current main; no execution permitted or claimed |
| TYPED_HYPERV_VM_ID | R05, R21 | BLOCKED | #620 typed admission source OFF, exact CI red and no physical approved VMId |
| VM_RUNNING_READBACK | R03, R21 | BLOCKED | #617 Get-VM denied; vmms and vmcompute running are services, not VM state |
| WINDOWS_JOB_PIPE | R07, R22 | SOURCE_FAIL | #618 iteration4 fast-exit; #576 OS signature UNAVAILABLE/ACL null; #608 only old combined green |
| SIGNED_ROLLBACK | R19, R21, R22 | BLOCKED | #551 current release CI pending and old source green; physical two-device canary absent |
| ARTIFACT_QUOTA | R10, R12, R15 | SOURCE_ONLY_PASS | #616/#610 source CI green, 1GiB physical worker and Cloudflare D1 staging not verified |
| OWNER_WSS_SCOPE | R06, R12, R20 | SOURCE_ONLY_PASS | #612/#613 CI green; WAN physical production not verified |

## Independent production hard stops

- **#271 physical trust:** previous actual read-only Naveax legacy C:\ProgramData\NexowireStack and cli.js ACL inherited Authenticated Users Modify, Broker protected ACL unavailable. No elevated trust while low-trust actor can replace code. No ACL changes in this QA.
- **#551 actual signed release:** latest source CI 39606595530 and release readiness 39606595531 both SUCCESS; first-party Nexowire-owned signed native Broker installer, COMPLETE signed old binary rollback archive, real owner local UAC consent and Windows VM canary remain unperformed.
- **#587 actual replay witness:** simultaneous SQLite Journal+Authority backup rollback re-admits historical requestId. #614 PostgreSQL external witness design source CI green but uses in-memory SQL contract simulator, no independently managed trust root or physically tested re-pair/restore.
- **#617/#620 Hyper-V:** no trusted per-owner/host/device VMId GUID allowlist enforced by real signed elevated Broker, Get-VM read-only denied, no independently verified Running or Off state. vmms/vmcompute Running, consent.exe sighting or HTTP 401 is never a valid VM/approval/Broker attestation.
- **#576/#618 Windows Job:** exact newest HEAD red despite prior #608 combination green. Signed helper/parent/updater effective ACL and native process proof cannot be promoted to production.

## Evidence files and controls

- QA_20261021_CORE_MASTER_ACCEPTANCE.json contains the exact HEAD SHA/CI, 14 requirement gates and all blockers.
- PR_SOURCE_AND_RELEASE_GATES.json holds 57 distinct PR snapshots, QA_BLOCKING_FINDINGS_CURRENT_MAIN.json holds 22 findings, cross-project-final-acceptance.json holds 22 four-level requirements.
- Test files: qa-core-broker-p0-negative.test.ts plus qa-core-master-evidence.test.ts. Intentionally RED runtime source tests remain active in the non-skipped qa-independent-negative-acceptance CI job.

**NO live elevated shell, Hyper-V, Agent/Broker/service update, UAC Secure Desktop interaction, ACL modification, VM state change, file mutation or payment deployment. Final Acceptance BLOCKED.**
