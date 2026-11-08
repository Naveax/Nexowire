# P006 skill evidence — source compatibility is not installed acceptance

Snapshot: 2026-11-08. Upstream `Naveax/Nexowire` `main` **`52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`** (#1135). At this exact main, `src/skills/manifest.ts` blob is `83e30bbd16fb30d53bddaa5e916da16ac20a31d0`, `src/skills/registry.ts` blob is `77d6a74bf715093b54f467cb4367d66c692f07a2`; local test checkout uses byte-identical blob hashes. This independent P006 branch adds only `test/delegated/k17/**` and starts remotely from that current main SHA.

Issues: [#780](https://github.com/Naveax/Nexowire/issues/780), [#539 R17](https://github.com/Naveax/Nexowire/issues/539), [#1006](https://github.com/Naveax/Nexowire/issues/1006).

## T-631 and T-636 — actual metadata/registry behavior

- The current manifest parser rejects unknown explicit platform values (`windows`, `unknown-os`), but omitted `platforms` becomes `any`. Evaluating that fallback as platform-compatible on Linux does **not** establish Linux installation, UI, native Agent or device support.
- A valid quoted mixed-case `name: "CaseFixture"` loads from the exact `CaseFixture` directory and validates. A mismatched `name: casefixture` is rejected by `SkillRegistry.load('CaseFixture')` and visible as an error in `validate()`. This tests the actual source parser and registry, not a mock of the production parser.
- The older [Draft PR #1030](https://github.com/Naveax/Nexowire/pull/1030) also contains case-collision metadata work; **do not duplicate its registry/source patch** in this branch.

## T-632 — open symlink bug reproduced, not passed as fixed

An isolated temporary catalogue has a symlinked `linked-skill/` outside its root, with a harmless synthetic `SKILL.md`. With the current source:

1. `SkillRegistry.list()` skips it; `validate()` returns no `valid` entry.
2. Direct `SkillRegistry.load('linked-skill')` nevertheless reads the outside file and succeeds.

The fixture is named **`KNOWN OPEN GAP`**. Its 1 PASS means **reproduction successfully detected**, **not** that path containment/security is safe. No fix to registry direct-load trust, authorization, sandbox, symlink policy, or owner [#1080](https://github.com/Naveax/Nexowire/pull/1080) was attempted. Real Windows symlink behavior is NOT_RUN.

## T-633 — platform/installer execution ledger

| Claim/test | Source checked | Executed OS command? | Acceptance |
| --- | --- | --- | --- |
| Manifest `platforms: win32` is incompatible with a `linux` evaluation | Yes, Node fixture | No native Agent or installation | SOURCE_ONLY |
| Missing platforms defaults to `any` | Yes, parser | No platform install | UNKNOWN for actual OS support |
| Windows native installer/PowerShell process and ACL | No | **No** | **NOT_RUN** |
| Linux actual package install/device grant/service | No | **No** | **NOT_RUN** |
| macOS Agent/GUI control | No | **No** | **NOT_RUN** |

Do not infer success from a filename, a declared OS list, an unexecuted command or passing Linux source tests.

## T-634 — exact commit CI is different from nested test execution

- Prior K17 [Draft PR #1113](https://github.com/Naveax/Nexowire/pull/1113), exact SHA `079cef00aaabc093fe400b47ef71e65144dff0f6`: [CI run 42474111487](https://github.com/Naveax/Nexowire/actions/runs/42474111487) **7/7 completed-success jobs**. Source job steps were inspected and **none explicitly named K17**, `issue780-catalog-audit`, or `issue780-capability-promise`. Thus general CI was green, but K17 nested tests were **NOT_PROVEN hosted**. We did not restart the workflow.
- K13's [#1134 auxiliary runner](https://github.com/Naveax/Nexowire/pull/1134) reported four hosted successful jobs that **explicitly ran K09 and K16**, not K17. That evidence cannot be borrowed for this K17 branch.
- This P006 branch's own nested `.test.ts` is run locally by exact command; until hosted job/logs explicitly demonstrate invocation and outcomes for this new HEAD, **HOSTED_NOT_PROVEN**.
- The six-case offline fixture separately confirms that seven generic-success job records don't imply a named K17 nested test step. A positive named-step fixture is **necessary but not sufficient** without TAP/test output.

## T-635 — conflicts and ownership

Upstream current main has the skill source hashes noted above. [#1030](https://github.com/Naveax/Nexowire/pull/1030) still owns its manifest/registry metadata fixes; [#1080](https://github.com/Naveax/Nexowire/pull/1080) owns protected sandbox work; owner [#1096](https://github.com/Naveax/Nexowire/pull/1096) includes protected CORE/CI. This new branch changes none of those paths, only a dedicated source test and this report. No rebasing, force pushing, cross-PR merge or issue closure was performed.

## Local verification and limits

```sh
node --import tsx test/delegated/k17/p006-skill-source-evidence.test.ts
# 6 PASS / 0 FAIL / 0 SKIP; the symlink PASS is reproduction only
node --import tsx --test test/delegated/k17/p006-skill-source-evidence.test.ts test/skills.test.ts test/shipped-skills.test.ts
# 18 PASS / 0 FAIL / 0 SKIP
npm run typecheck  # PASS; executed on this source tree
npm run build      # PASS; executed on this source tree
```

Full `npm test`, physically installed Windows/Linux/macOS, 2-PC, production and owner sandbox acceptance: **NOT_RUN**. #780/#539 remain open; ŞEF owns #1006 merge/acceptance decisions.

## P007 D-097…D-102 — existing PR #1150 completion handoff (2026-11-08)

The V006 instruction supersedes earlier work: **no new PR** and **no merge without Ömer's explicit approval**. This section updates only existing #1150, with no registry/parser/security runtime changes.

### D-097 / D-099 — second concrete path read and honest interpretation

The earlier P006 fixture reproduced an *external symlinked directory*, which normal catalogue enumeration omits. A new fixture checks a **normal in-root directory whose `SKILL.md` is a symlink pointing outside the catalogue**. The current `SkillRegistry.load()` reads that external file, and `validate()` considers the resulting manifest valid. This proves that merely rejecting symlink *directories* would not address the manifest-file entry point.

The new test is explicitly named **`KNOWN OPEN GAP`**. Its passing TAP result means **the negative behavior was observed**, not that the security boundary now rejects external reads. The protected runtime still needs an owner change. Parent 18/18 test result was earlier HEAD; updated local selection is **19/19 PASS (2 independent OPEN-GAP reproductions)**.

### D-098 / D-100 — SHA, duplication and hosted callsite

| Draft PR | Exact HEAD before this P007 update | Generic hosted CI | What remains outside that evidence |
| --- | --- | --- | --- |
| [#1030](https://github.com/Naveax/Nexowire/pull/1030) | `bc97cd84c7b224cdfe140a77a7f9200d6bcf50e4` | [run 41338216468](https://github.com/Naveax/Nexowire/actions/runs/41338216468) `action_required`, **0 jobs** | Protected manifest/registry diff, case collisions and direct-load TODO; no merge gate |
| [#1113](https://github.com/Naveax/Nexowire/pull/1113) | `079cef00aaabc093fe400b47ef71e65144dff0f6` | [run 42474111487](https://github.com/Naveax/Nexowire/actions/runs/42474111487) **7/7 SUCCESS** | Job steps lack explicit named K17 nested tests; hosted K17 scope **NOT_PROVEN** |
| [#1150](https://github.com/Naveax/Nexowire/pull/1150) | `fb7e4cadcccfd0e073aa1ab28f1f55d61ab85f35` | [run 42485540131](https://github.com/Naveax/Nexowire/actions/runs/42485540131) **7/7 SUCCESS** | Generic CI jobs do **not** prove its new nested `p006-skill-source-evidence.test.ts` actually executed |

Distinct work: #1030 owns parser/case-collision metadata improvements; #1113 scans catalogue symlinks and claim text without following them; #1150 independently calls the *actual* registry and reproduces direct-load boundary failures. No copied source patch, no runtime owner change. K13's #1149 helper workflow ran seven **main-existing** delegated files, not unmerged K17 #1150. #1149 auxiliary 33/33 checks are not #1150 hosted acceptance.

### D-101 — physical NOT_RUN ledger

- Linux: two harmless Node temp symlink fixtures ran locally. This is **not** a Linux production/native-agent path policy check.
- Windows: file symlink creation and reparse/junction/UNC/NTFS identity behavior **NOT_RUN** (tests explicitly skip on win32); no UAC/Broker/installer.
- macOS: native filesystem and Agent symlink behavior **NOT_RUN**.
- Real device/install/canonical path race, SDK admission, permissions and user-grant revocation **NOT_RUN**.

### D-102 — owner-only minimal corrective test contract

1. Validate the requested skill **name** first (reject traversal, alternate separators, absolute paths, NUL), and resolve the trusted catalogue root against a known owner-approved directory. Do not treat lexical string-prefix matching (`/skills-good` vs `/skills`) as containment.
2. Reject or explicitly authorize **both** symlinked skill directories and symlinked `SKILL.md` files; also cover dangling links, nested links, junction/reparse points, path casing and path components that look like the root's prefix.
3. Require the actual file handle/read target to remain inside the trusted directory. `lstat`/`realpath` followed by a later ordinary `readFile` alone can race an attacker changing the path; consider platform-appropriate no-follow/handle identity and verified readback, with owner design review. No invented cross-platform guarantee.
4. Add owner source regressions asserting direct `load(name)` **rejects** both external directory and external manifest symlinks, not merely that `list()/validate()` hide them; use benign temp fixtures. After owner implementation, the two K17 *reproduction-as-PASS* tests will need conversion into rejection assertions rather than silently remaining green against a repaired implementation.
5. Keep task-sandbox, capability/admission and real OS integration behind [#1080](https://github.com/Naveax/Nexowire/pull/1080)/#1096 protected ownership. Exact-SHA hosted test discovery and actual Windows/Linux/macOS acceptance remain independent gates.

P007 local run: `node --import tsx --test test/delegated/k17/p006-skill-source-evidence.test.ts test/skills.test.ts test/shipped-skills.test.ts` **19/19 PASS**, containing the two explicit open-bug reproductions. New exact HEAD hosted and physical checks must be recorded separately, never inherited from previous SHA.
