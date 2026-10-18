# Independent QA: source and release acceptance (2026-10-18)

**Snapshot main:** `ca7fc2c457cd47181e5b5d6c4db7b0ac32698838`; previous main CI [39151346547](https://github.com/Naveax/Nexowire/actions/runs/39151346547) SUCCESS at 8660ac1; current main CI [39154393827](https://github.com/Naveax/Nexowire/actions/runs/39154393827) SUCCESS. **No final acceptance.**

## Grounded results

- The machine-readable [R01-R22](cross-project-final-acceptance.json) has 6 source PASS, 15 source BLOCKED, 0 current-head source FAIL, 1 source NOT_TESTED. All 22 staging, production and original incidents remain BLOCKED.
- The [25-PR inventory](PR_SOURCE_AND_RELEASE_GATES.json) separates GitHub state, exact PR SHA, checked CI and missing original-incident gates. PR merge never changes acceptance status automatically.
- #549, #552, #558, #559, #546, #555, #554, #557 and #561 are merged to the main line at the snapshot. #553, #563, #480, #556 and #551 remain DRAFT. #564, #550 and independent QA #560 were subsequently merged, but do not constitute production acceptance.
- Both physical Nexowire Agents returned version 1.0.5. No Agent rollout, device restart, USB write, firmware operation, billing change or user-data deletion was performed.
- Historic QA branch #560 CI [39150335922](https://github.com/Naveax/Nexowire/actions/runs/39150335922) SUCCESS. The existing tests cover structural release gating, not trusted external proof.
- On a read-only detached QA checkout of main, 56 narrowly selected regressions produced **54 PASS / 2 FAIL**. Both process-tree failures were `WINDOWS_JOB_HELPER_UNAVAILABLE` because the native helper had not been compiled inside that disposable checkout; this is a missing test prerequisite, **not evidence of an ownership regression**. GitHub main CI has already compiled the native helper and passed separately.

## Six blocking finding files

See [QA_BLOCKING_FINDINGS_CURRENT_MAIN.json](QA_BLOCKING_FINDINGS_CURRENT_MAIN.json) for affected SHA(s), exact isolated reproduction steps, expected correction, and four separate statuses. All findings keep production and original incident BLOCKED. No synthetic CI result is described as real two-device acceptance.

| Finding | Component | What is proven | Release gate |
|---|---|---|---|
| QA-P0-559-HELPER | Win32 Job helper | Env override removed; binary type and marker trust are insufficient as independent release/publisher proof | Trusted helper binary + kernel membership + physical original child cleanup |
| QA-P0-553-PATH | Filesystem/USB | Latest CI success; live console grant issuance and handle-relative TOCTOU protection missing | Real grants, handle pinning, USB/junction stress |
| QA-P1-563-DOCTOR | Environment Doctor | Historical head Linux Node22 failed; latest #563 head fixes test and provenance paths, exact-head CI currently IN_PROGRESS | Correct tests plus fail-closed provenance across OS |
| QA-P0-480-556-GUI | Private GUI/file picker | Static broker gate and UIA adapter are source-only; no demonstrated dynamic descendant containment | No Default desktop focus/input, real Common Dialog |
| QA-P1-551-INSTALL | Lifecycle | Exact-head CI success; manager still fixture-driven without installed production adapter | Signed installer/rollback on actual authorized devices |
| QA-P1-564-FAIRNESS | Scale S5 | Synthetic unfairness shown, live WSS 24h/cost absent | Real account-scoped fairness, 24-hour accepted completions |

## Evidence rules

1. Exact source SHA and successful source CI are not equivalent to staging/production.
2. A source FAIL remains FAIL if the matching test reproduces a defect; a known test-precondition failure is documented separately instead of mislabeled.
3. Original incident closure needs an independent postcondition captured on the actual affected system, with operator authorization, receipt hashes and regression evidence.
4. Tool/provider policy, OS UAC, real firmware, payment processors, or third-party OAuth authority cannot be bypassed to manufacture a PASS.
5. The source-level QA manifest and optional reviewer metadata are **not** a cryptographically validated signature or evidence oracle.

**Release decision: BLOCKED.**