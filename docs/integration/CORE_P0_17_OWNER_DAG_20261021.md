# #00 integration / CORE P0 truth and 17-owner source DAG

Snapshot: 2026-10-21, verified `main` `4c5c810134c020cd04a5ef2be5c1138ea1954ad0`. This is an **evidence snapshot**; check current GitHub heads, reviews, and exact SHA CI again before merging. Does not change Agent, Hub, Broker, Windows, Cloudflare, quotas or billing. Umbrella issue [#539](https://github.com/Naveax/Nexowire/issues/539): R01-R22 are NOT production-accepted merely because source tests pass.

## Owner/source DAG (00 + 01-16 = 17 roles)

| Owner | Independent scope / live PR references | Dependency / cross-owner boundary |
|---|---|---|
| #00 | main merger, this evidence-only PR | hold merges when source CI, review, physical release differ |
| #01 Journal | #582 -> child #607 -> child #614; P0 #587 | rollback-external witness must be actually authoritative; local SQLite/Map not proof |
| #02 Error Contract | #619 (child #618), #599 (QA) | preserve requestId and UNKNOWN no-replay, #617; do not edit #03 native code |
| #03 Windows Job/Process | #576, #608; #620 typed Hyper-V gate | Job helper signing/ACL #271, dispatch disabled, output drain; #620 edits privilege classification, NOT generic elevated shell |
| #04 Access/CORE | #574, #618; #617/#323 | 15-minute ROOT request and durable CORE preference != effective Windows token or local UAC consent |
| #05 filesystem/USB | #553 | volume identity, handle TOCTOU, physical grant/revoke; #588 >256MiB offset work isolated from #08 |
| #06 reconnect | #613, merged #605 | epoch, owner, lost ACK, cancellation and chunk CAS; do not write #08 store |
| #07 HTTP/OAuth | #598 with #608 integration | finite 9.5MiB HTTP body, Host validation, gzip parser admission, no provider bypass |
| #08 Artifact Bridge | #596 -> child #616, #588 | durable one-call job / SHA256 / staging quota; #05 native file range and #06 reconnect |
| #09 GUI | #602 -> child #611, old #480 covered by #570 | verified HWND/session and protected desktop boundaries, no secure UAC clicks |
| #10 | No specific current source PR owner verified in this intake | reserve ownership until assigned; do not invent code/file scope |
| #11 Progress | #575 | immutable trusted results not PID-only/ACK-only; interface with #08, no store mutation |
| #12 Installer | #551 | signed first-party release, ACL #271, real rollback and physical canary |
| #13 WSS signed enrollment | #612 | signed nonce, owner/device binding, staging only |
| #14 Quota | #610 | trusted receipt for cancellation refunds, must not infer disk reclaim |
| #15 Scale S5 | #615 | bounded fairness vs genuine 100+ completed WSS/24h/actual provider cost proof |
| #16 Independent QA | #572, issue #539 | R01-R22 negative matrix, independently reproduce defects, no skip/unproved PASS |

**Directed integration boundaries:** `#619 -> #618`; `#614 -> #607 -> #582 -> #587`; `#616 -> #596 -> #588`; `#608 -> #598 + #576`; `#551 -> #271 and signed rollback`; `#620 -> #617 typed admission only`. Child arrows indicate target branch dependency, not authorization to merge to main.

## Exact-head CI and review snapshot (not an approval)

| PR | Exact HEAD | GitHub workflow evidence | Gate |
|---|---|---|---|
| #618 | `512a1764d65efbfb448577687225d71e3a845a8d` | `39605003581` FAIL (browser-live fast-exit stdout, 6/7 jobs pass) | DRAFT/NO-MERGE |
| #619 | `6f6c2b3812afadadaa0f123f5d40105eead6d054` | `39604390404` SUCCESS on child base #618 | child only; parent failure remains |
| #620 | `4ba879f591d19ddff3ca1e4cba0cf7ecc8a832b4` | `39604898508` FAIL (Windows Authenticode fixture exit 1, lowtrust ACL fixture `null` rather than true) | DRAFT/NO-MERGE |
| #574 | `2adf0e29fd41914a842cafd7fdadef25d24da103` | `39604153782` FAIL | DRAFT/NO-MERGE |
| #576 | `a3946c1f25b8ba151baf945b5acacc7aafbd66c3` | `39598258315` FAIL Windows signature and ACL fixture; `39598258314` SUCCESS other workflow | DRAFT/NO-MERGE |
| #608 | `d34c0d3c85bc508be50c2e5f532aa964d8325106` | `39503650650` 7/7 SUCCESS and package `39503650638` SUCCESS; no submitted security review at last check | DRAFT combined source proof, NOT direct main merge |
| #614 | `ef1e3b23b01300e5f3bfe3769701b5b1446db5bd` | `39598693419` SUCCESS | child #607; PostgreSQL contract simulation is NOT external authority acceptance |
| #616 | `94b92e01219aca3cd4ca86775fe4b61a72ac53c4` | `39598755514` SUCCESS | child #596; no installed 1GiB physical transfer claim |
| #551 | `9fdee36897ded643594795ba354fc25e894b65c3` | `39606595531`, `39606595530` IN PROGRESS at snapshot | DRAFT; no signing/rollback/production approval |

Existing independent #00 main-source test on `4c5c810...`: `test/core-elevation-effective-truth-matrix.test.ts` plus existing authorization/ROOT/CORE tests 21/21 PASS, typecheck/build PASS. No native elevated operation was executed.

## ROOT 15-minute / CORE persistent: desired versus effective

- `FULL`: standard user-space broad scope subject to authenticated owner/provider policy; **never** infer elevation from a UI label.
- `ROOT`: an owner request may carry a maximum **15 minute lease**. Existing stored lease is NOT session-bound; current `authorization-explain` intentionally returns `root.policyActive=false` even if `leaseUnexpired=true`. Expired at 900 seconds, revoked at logout/owner change in a future implementation.
- `CORE`: indefinite but revocable owner preference, currently `PAUSED_UNVERIFIED` when enabled. It is **not** an effective elevated Broker. The verified installed principal, code identity, signed release/ACL and authenticated device binding must be true before UI may claim elevated authority.
- A trusted one-time installer/bootstrap may request a **real local Windows UAC approval once** for a protected privileged Broker. After successful attestation the broker may dispatch separately authorized commands without a new per-command UAC dialog **when permitted by Windows security policy**. This is a target design, **not** deployed or proven here. Normal UAC Secure Desktop cannot be remotely clicked or bypassed.
- #620's `hyperv.vm.start/stop/status` are only typed schemas and `HYPERV_ELEVATED_DISPATCH_ENABLED=false`; `shell.exec` is NOT promoted to admin. Never infer successful `Start-VM` from `consent.exe`, process ACK, CORE preference, VM name or stale state. `MUTATION_STATE_UNKNOWN` demands privileged independent `Get-VM -Id` and requestId audit, not replay.

## Four mandatory release states (per PR and R01-R22)

| Phase | Current evidence |
|---|---|
| source tested | Only per exact HEAD and exact named tests; several PRs red |
| staging accepted | **NO** for CORE/Hyper-V/Job/installer/CAS/USB |
| production deployed | **NO**; existing Agent v1.0.5 unchanged |
| original incident closed | **NO** for P0 #617/#271/#587 and umbrella #539 |

**Hard P0 NO-GO:** #271 live elevated legacy ProgramData executable/import ACL is untrusted-writable; #551 lacks independently accepted signed bootstrap and rollback; #587 requires real remote monotonic co-rollback proof, not simulated Postgres or in-memory witness. Also #576 signed Job helper and #617 typed Hyper-V physical authorization remain unaccepted. A green source job never overrides these release gates.