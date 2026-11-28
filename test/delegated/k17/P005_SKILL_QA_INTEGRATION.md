# #780 / #539 R17 — P005 skill catalogue QA and exact-CI gate

Snapshot: 2026-11-08. Current upstream `main` is `b5a3f8840517d65ecbd6a018699c4c8bdde09987` (#1102 merge). Its one-commit difference from the preceding `4e7db16f4233048a956664bef6b607781eb63fb7` changes only S5 ops metrics and K11 tests, **not** skill sources or this suite. This is source/VM QA, not installed-agent or physical platform acceptance.

## T-491 / T-496 — no double counting and combined-source verification

| Coverage | [#1030](https://github.com/Naveax/Nexowire/pull/1030) Draft | [#1113](https://github.com/Naveax/Nexowire/pull/1113) Draft | Resolution |
| --- | --- | --- | --- |
| Duplicate frontmatter, name/path and platform UNKNOWN | Runtime duplicate-key rejection, metadata inventory and negative tests | Read-only independent inventory detects duplicate/name/UNKNOWN | Keep runtime parser fix solely in #1030; do not transplant it into #1113. |
| Symlinks and path containment | Registry listing/direct-load TODO, Markdown link target audit | `lstat` of catalog directory and SKILL.md without following links | Complementary checks; direct-load TODO **still open** under security owner. |
| Capability and privilege metadata | Parser evaluation cannot grant capabilities from prose | Four conditional read-only fallback/prefers candidates | Different assertions; no admission or grant policy patch. |
| Explicit platform promise | Generic metadata UNKNOWN | Narrow `runs on`/`supports` language vs manifest platform declarations | #1113 QA only; false positives and typos fixed in the audit below. |

Local isolated integration: from the #1113 source snapshot, cherry-picked the **two** local #1030 commits `a534c0e` and `1823d05` (temporary worktree commits `960fd96`, `d2a2d4`), plus #1113's P005 regression commit (`bf2d843`, temp `b256b04`). No merge conflicts, runtime authorization changes, or upstream merge. The main branch already lacks these source commits. Do **not** count this disposable integration commit sequence as a published PR.

Executed **together** in the integration worktree:

```sh
node --import tsx --test test/delegated/k17/*.test.ts test/skills.test.ts test/shipped-skills.test.ts
# 37 tests: 36 PASS, 0 FAIL, 1 TODO (direct SkillRegistry.load symlink escape)
npm run typecheck  # PASS
npm run build      # PASS
```

The TODO is a genuinely failing assertion labeled TODO; it is **not PASS**, and does not justify closing #780.

## T-492 / T-494 — reproduced audit defect and minimal fix

The legacy manifest parser accepts individually quoted values, for example:

```yaml
name: "quoted-skill"
description: Runs on Windows
platforms: "linux", "win32"
```

Before the fix, `auditManifestText('quoted-skill', source)` incorrectly produced **both** `identity-mismatch` and `unsupported-platform-claim` although `parseSkillManifest(source)` accepted the identity/platforms and `evaluateSkillManifest(..., { platform: 'win32' })` returned compatible. P005 regression test went **RED** (2 new tests failing), then aligned audit field unquoting with the runtime parser; test is now **GREEN** (7/7 audit tests, previous 5/5 plus 2 new).

Separate source repro: omitted/mistyped `platforms` silently defaults to `['any']` in the runtime parser and can evaluate as platform-compatible on Windows, macOS and Linux; this **does not prove installed OS support**. The read-only audit preserves its `platform-unknown` result and now also flags narrow mistyped keys `platform`, `platfoms`, `requires-any`, `require`, `priviledge`, `descripton`. Such typos can silently drop explicit constraints/descriptions. It does not reject custom extension keys or change runtime admission.

## T-493 / T-495 — containment and owner collision boundary

Current catalog scan: 45 directories; no known symlink directory, symlink SKILL.md, or other source finding. Synthetic negative test in #1113 excludes symlinked directory and manifest without reading link destinations. This is not a race-free path sandbox or proof about `SkillRegistry.load()`: direct-load symlink escape remains the #1030 TODO and security owner concern. [#1080](https://github.com/Naveax/Nexowire/pull/1080) remains the separately owned Git/task sandbox Draft; none of its security/runtime files was changed by K17. Do not present metadata QA as #1080's OS isolation acceptance.

## Hosted and physical acceptance (separate from local PASS)

- #1113 earlier exact HEAD `d119cae092b5cb6e7a2b259cc111a17c970fa3a0`: [CI run 42411705640](https://github.com/Naveax/Nexowire/actions/runs/42411705640), **7/7 jobs SUCCESS** (Node22/24 matrix, live job names). However the reported job step names include **no explicit K17, `issue780-catalog-audit` or `issue780-capability-promise` invocation**; the nested test collection is **not evidenced** by that green result.
- After the new P005 code commit, the prior CI result is **historical only**. Its exact new HEAD requires separate hosted status; do not re-dispatch an already running workflow.
- #1030 exact HEAD `bc97cd84c7b224cdfe140a77a7f9200d6bcf50e4`: CI run 41338216468 `action_required` / empty jobs; **not green**.
- Real Windows/macOS/Linux device/platform support, OS filesystem sandbox, source PR merge, two-PC connection and production acceptance: **NOT_RUN**. K13 owns delegated test discovery infrastructure.

Issue #780/#539 remain open. CI green is not a substitute for running the new nested QA or for owner review of four conditional read-only declarations.
