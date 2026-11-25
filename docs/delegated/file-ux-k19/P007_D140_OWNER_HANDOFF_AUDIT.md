# P007 D-140 — Owner handoff links and evidence freshness (K19, 2026-11-09)

**Read-only integration audit for ŞEF / Ömer, not a merge authorization.**
Source: [team P007 / V006](https://github.com/SinsiVinci/Nexowire-fork/tree/ekip/ekip),
[#1006](https://github.com/Naveax/Nexowire/issues/1006), and each
PR's **current exact HEAD** checked on 2026-11-09. These are distinct
source/CI/physical gates. K19 changes no CI, product, owner, or live files.

## Material delta since ŞEF S007 / PR inventory (8 November)

| Request / owner action | Exact evidence reviewed | Result and unresolved boundary |
| --- | --- | --- |
| **K20 fixed 41 false-RED** — Ömer owns `ci.yml` | Upstream `main` workflow blob `90185b6f...` still uses `grep -qx '# tests 41'` and `'# pass 41'`; [#1152](https://github.com/Naveax/Nexowire/pull/1152) current HEAD `88b893e78320c3ca2a13d5266e5d9c41c178a43d`, [run 42515294810 / test(24) job 128836894983](https://github.com/Naveax/Nexowire/actions/runs/42515294810/job/128836894983) shows **62/62 TAP PASS, 0 fail/cancel/skip/todo** followed by **job exit 1**, `test(22)` cancelled | **Not CI PASS on #1152.** In *unmerged owner #1096* HEAD `43e8125e7a4ced654a769b661dc10938c02bc7a4`, workflow blob `d2139519...` replaced literal 41 equality with `scripts/ci/assert-tap-summary.mjs ... 41` (minimum, dynamic pass==tests). Helper blob `38786c04...` rejects missing/duplicate/nonzero FAIL/CANCEL/SKIP/TODO and has test fixture. [Owner CI 42517451677](https://github.com/Naveax/Nexowire/actions/runs/42517451677): `test(22)` and `test(24)` K20 step SUCCESS; **owner branch staging only**, not proof of a combined #1152+owner merge nor main fix. |
| **Seven missing delegated tests** — K13 owns auxiliary, Ömer required CI | [#1149](https://github.com/Naveax/Nexowire/pull/1149) exact HEAD `b6b5e60ba93f1a40fab432fedc06d334971a6c37`; [required 42514702344](https://github.com/Naveax/Nexowire/actions/runs/42514702344) **7/7 generic SUCCESS**, but this alone does not attest seven paths. [Fork auxiliary 42514696323](https://github.com/SinsiVinci/Nexowire-fork/actions/runs/42514696323) **4/4 jobs SUCCESS** (two selected seven-path source jobs and two pinned #1112 historical jobs; auxiliary, not required). | On current **unmerged** owner #1096 `ci.yml` three of K13's seven paths have **explicit invocation** within the S5 step: `test/delegated/k11/issue-487-commercial-unknown.test.ts`, `test/delegated/k11/issue-487-meter-acceptance.test.ts`, `test/delegated/k11/p005-s5-evidence.test.ts`. [Owner CI 42517451677 test(24)](https://github.com/Naveax/Nexowire/actions/runs/42517451677) log contains all three paths and the step succeeds. **Four** are not named by that owner's `ci.yml`; do not claim required discovery closure. |
| **Four remaining delegated path gaps** — Ömer/K13 | Compared exact owner workflow blob `d2139519...` with K13 [seven-path inventory](https://github.com/Naveax/Nexowire/blob/b6b5e60ba93f1a40fab432fedc06d334971a6c37/scripts/delegated/k13/P006_SEVEN_PATH_CI.md) | `test/delegated/k09/roadmap-evidence.test.mjs`, `test/delegated/k16/environment-doctor-contract.test.ts`, `test/delegated/pool-k17/markdown-anchors.test.ts`, `test/delegated/pool-k19/audit-physical-pass-labels.test.ts`: **no explicit file-name callsite found in owner `ci.yml`** (read-only source comparison; it does not exclude an unrelated dynamic runner). Request exact-head/log confirmation if another workflow executes them. |
| **Cross-device #588 / #539 R15** — owner file transfer + K18/K19 | [#1151](https://github.com/Naveax/Nexowire/pull/1151) HEAD `6ccf58e6f0e7ea2e84035c14bde1382ab8b2422e`, [42514934917](https://github.com/Naveax/Nexowire/actions/runs/42514934917) generic success; [#1147](https://github.com/Naveax/Nexowire/pull/1147) HEAD `f552c77983fa73feeb3220e961c23bd747b76641`, [42514930232](https://github.com/Naveax/Nexowire/actions/runs/42514930232) **7/7 generic SUCCESS**. `test(22)` job `128835758166` executes two older K19 files but **not** the four newer nested K19 tests, including `p006-receiver-ack-reference.test.ts`. | [Real original owner Work PC HTTP 413](https://github.com/Naveax/Nexowire/issues/588#issuecomment-6289416326) occurs **before tool result** for one approximately 230 KiB MCP message. Four bounded calls did write/hash **231,474 bytes** on that historic PC. This does not resolve single logical invocation, deployed streaming, reconnect, or **receiving-device-authorized ACK with independent SHA readback**. Four file-transfer source blobs on owner #1096 and current main remain identical; physical/current-deployment gates OPEN. |
| **Owner core / web** — Ömer review | Owner [#1096](https://github.com/Naveax/Nexowire/pull/1096) HEAD `43e8125e7a4ced654a769b661dc10938c02bc7a4`: [CI 42517451677](https://github.com/Naveax/Nexowire/actions/runs/42517451677) **9 successful jobs / 3 conditional skipped**; [Release Readiness 42517451658](https://github.com/Naveax/Nexowire/actions/runs/42517451658) success. Owner [#1068](https://github.com/Naveax/Nexowire/pull/1068) HEAD `94d38799e9e4b50fe84f7924e6fc84f90aeba090` remains open Draft; [41728679793](https://github.com/Naveax/Nexowire/actions/runs/41728679793) earlier generic success. | Success on individual owner branches **does not authorize merging** K13/K20/UI/CORE or claim physical Windows, two-PC and real browser acceptance. Four old UI Drafts overlap the #1068 web paths; no separate forced merge. |
| **Other explicit owner gates** — Skill and S5 | [#1150](https://github.com/Naveax/Nexowire/pull/1150) HEAD `bf6d5c6e4efefd6ccecae7fc54876621cc846cac`; [#1148](https://github.com/Naveax/Nexowire/pull/1148) HEAD `5b0f98c2f41ac332b02d8b8fc78beff9e5efda7d`; [#1109](https://github.com/Naveax/Nexowire/pull/1109) HEAD `d14a24c52243371d1111634d26ea0e256164b7ac`; [#487](https://github.com/Naveax/Nexowire/issues/487) OPEN. | Source/QA cannot replace symlink security remediation, live provider/24h capacity and pricing data, or operator release acceptance. Keep separate owner decisions and NOT_RUN. |

## One concise owner decision packet

1. **CI:** review the dynamic TAP gate already **staged** in #1096, validate
   it with K20's 62-test variant in a **combined owner-controlled exact-SHA
   candidate**, and explicitly cover the four remaining K13-delegated paths
   (and K19's nested tests if desired). Current-main #1152 is still RED.
2. **Delivery:** separately decide which of the existing Drafts to integrate
   after exact-head test-discovery, source overlaps and approvals; do not
   use the 8 November 59-PR SHA inventory as immutable. #1149/#1152/#1151/
   #1147 have advanced since its snapshot. **No auto-merge/issue close.**
3. **File transfer:** authorize trace correlation to identify the real 413
   issuer; preserve safe bounded per-request payloads and make one logical
   transfer invocation schedule a durable stream. Test current Agent/Hub on
   two authorized disposable PCs with exact operation/device/path/size/SHA,
   reconnect, duplicate target, 256 MiB+ and an independently verified final
   receiver ACK. Historic manual chunks are evidence, not a product fix.
4. **Independent acceptance:** keep #1068 browser checks, Skill symlink
   safety, S5 real provider/cost and physical Windows/CORE controls as
   separate owner gates. Generic CI, VM tests and local SHA fixtures are
   not proof of actual installed-device or commercial acceptance.

Only K19-owned documentation was edited for this D-140 evidence audit.
All cited current SHA/run readings are timestamped snapshots; verify exact
HEAD again immediately before an owner merge decision.
