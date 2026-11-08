# Hosted browser evidence gap — issues #485, #539, #812

Source checked: upstream `main@b5a3f8840517d65ecbd6a018699c4c8bdde09987`.
K10 previous PR: [#1116](https://github.com/Naveax/Nexowire/pull/1116)
at `0f3916ecd3d3ff0db5d7a1743b007e52a0cd16aa`.

## Reproduced gap (T-449, T-454)

At PR #1116 exact SHA, [CI run 42411883766](https://github.com/Naveax/Nexowire/actions/runs/42411883766)
finished **7/7 jobs with success**. GitHub `browser-live` job `128521601829`
executes `test/browser-live.test.ts` and Windows/Agent lifecycle checks, **not**
`scripts/delegated/k10/browser-visual-smoke.mjs`, the three-state screenshot
capture, or an authenticated pairing/keyboard/screenshot test of `web/connect`.

Detailed source + run inspection (P006 T-589): `test/browser-live.test.ts`
blob `c8896a5d3e9c9533c06b0225f25e8675df522ba9` is unchanged between
`main@b5a3f884` and `main@52d452f7`. It starts a temporary loopback HTTP
server returning an inline page with `#name` input, `#go` button and
`#status` element, then launches **real headless Edge at 800×600** via
`BrowserManager`. It fills, clicks, visually verifies `#status`, and checks
in-memory PNG screenshot bytes/dimensions/SHA-256. [PR #1142 exact-head job
128712328389](https://github.com/Naveax/Nexowire/actions/runs/42474389141)
ran this **one browser test successfully** on Windows. That is valid real
Edge/BrowserManager coverage of an **ephemeral sample page**, not proof that
the Nexowire `web/connect.html` onboarding page rendered or paired a device.

The two `test (22/24)` jobs' `Verify K10 offline web shell and QA24 integration
DAG` step explicitly runs `offline-web-smoke.test.mjs`, the old pool inventory,
and `qa-24-integration-dag.test.ts`. It **does not** run the new
`issue-browser-negative.test.mjs` or `issue-evidence-contract.test.mjs` from
#1116. These new tests passed **locally** 4/4 and 8/8, but their discovery in
this hosted workflow was **NOT_RUN**. No green hosted result can be used as
proof they executed.

## Independent, allowed-source test/runner (T-450, T-452, T-453)

- `hosted-browser-evidence-audit.mjs` inventories explicit workflow `run`
  commands, rejects a stale run SHA, and refuses to equate a generic successful
  `browser-live` job with three captured states. No CI permission or source
  workflow is modified.
- `hosted-connect-three-state.mjs` is an **opt-in** Playwright-compatible
  static fixture runner: it loads `web/connect.html` locally, blocks HTTP(S),
  blocks `connect.js` to avoid real APIs, refuses file/symlink escapes, and
  renders three **synthetically labelled** layout states at the
  320/375/768/1024/1440 viewport matrix. It hashes output PNGs, checks decoded pixels/dimensions,
  rejects repeated image content, a supplied SHA unlike `git rev-parse HEAD`,
  and horizontal overflow. It cannot create
  an authenticated success state or test the real device/keyboard behavior.
- No Playwright version/browser is bundled or silently downloaded. On a runner
  without Playwright, script returns `NOT_RUN` with exit 2. Actual optional
  capture remains **NOT_RUN** until a properly equipped runner runs it.
- A synthetic fixture manifest claiming live pairing or Windows acceptance
  is rejected as `FAIL_FALSE_LIVE_CLAIM`; even 7/7 successful unrelated CI
  jobs cannot override missing exact K10 invocation/screenshots. Requested
  viewport widths remain listed when the browser is unavailable.

Reproducible local commands:

```sh
node test/delegated/k10/hosted-browser-evidence-audit.test.mjs
node test/delegated/k10/hosted-connect-three-state.test.mjs
node test/delegated/k10/offline-web-smoke.test.mjs
```

Optional on a specifically configured, **nonproduction** runner with an already
installed Playwright package/Chromium:

```sh
node scripts/delegated/k10/hosted-connect-three-state.mjs --out /tmp/k10-connect-visual-fixtures --source-sha "$(git rev-parse HEAD)"
```

CI owner K13 may choose to add explicit test discovery/capture invocation to
**their** delegated workflow after review. K10 must not change the owner
`.github/workflows/ci.yml` or K13-owned workflow. Tests must explicitly
appear in a completed job's logs at the same SHA to count as hosted coverage.

## Separate acceptance (not achieved)

- Real three-state runtime transitions, OAuth/pairing and responsive layout
  screenshots on an authorized real browser: `NOT_RUN`.
- Windows real user installation, device consent and native input authorization
  (#812): `NOT_RUN`.
- Actual browser keyboard/focus navigation for 375/768/1440: `NOT_RUN`.
- Source-only DOM/PNG fixture test passing never closes #485/#539/#812.

## P007 PR-readiness audit — D-055…D-060 (2026-11-08)

- **Two separate, still-Draft K10 PRs:** [#1116](https://github.com/Naveax/Nexowire/pull/1116)
  at `0f3916ecd3d3ff0db5d7a1743b007e52a0cd16aa` changes **six** K10
  paths (visual smoke, evidence contract, two issue suites, JSON manifest and
  `web/README.md`); [#1142](https://github.com/Naveax/Nexowire/pull/1142)
  previously at `550a6497fec85fddb0cfc1702e5b6556d8621d6a` changes **five**
  different K10 paths (hosted audit/fixture scripts, two hosted suites and this
  report). The diff path sets have **zero overlap**. The first enforces
  screenshot/manifest integrity and redaction; the second audits CI selection
  and renders labelled *offline* layouts. Both should retain their unique
  negative tests during owner-reviewed integration; neither replaces the other.
- **Exact-head CI:** #1116 [run 42411883766](https://github.com/Naveax/Nexowire/actions/runs/42411883766)
  and #1142 at the SHA above [run 42485334997](https://github.com/Naveax/Nexowire/actions/runs/42485334997)
  each completed **7/7 generic jobs SUCCESS**, including a real Windows Edge
  browser-live job on the separate 800×600 loopback sample. The `test (22)`
  and `test (24)` workflow steps select **only**
  `test/delegated/k10/offline-web-smoke.test.mjs`, plus old pool/QA24 paths.
  Neither PR's **four new nested K10 `.test.mjs` suites** appear in the required
  CI invocation. Their hosted execution is `NOT_RUN`, even when generic CI is
  green. [K13 #1149](https://github.com/Naveax/Nexowire/pull/1149) explicitly
  selects seven **other** nested paths on an auxiliary fork workflow and does
  not cover the four K10 suites; owner required `ci.yml` remains read-only.
- **Owner UI differential:** [#1068](https://github.com/Naveax/Nexowire/pull/1068)
  remains Draft; its `web/connect.html` adds `#error-title` and `#retry-hint`,
  `aria-busy` on `#pair-panel`, and a live region on the pair copy. The K10
  fixture's required IDs (`#connect-pill`, `#error-panel`, `#pair-panel`,
  `#chatgpt-panel`, `#chatgpt-status`, `#error-message`, `#device-name`,
  `#status-title`, `#status-text`, `#approve`) exist in **both** main and #1068.
  This is DOM anchor compatibility **only**, not owner browser visual or
  functional proof; K10 changes no `web` source.
- **False-positive fix (D-060):** The audit previously joined shell script
  lines into one long string. An unrelated `node --test other.test.mjs`
  followed by `echo test/delegated/k10/issue-evidence-contract.test.mjs`
  could falsely mark the echoed suite as selected. The audit now preserves
  statement boundaries, handles `\\`-continued real Node tests, rejects eval
  and requires `node --test` for `.test.*` paths. New positive and negative
  regression assertions distinguish invoked tests from merely named files.
- **Local Node 24 tests:** #1116 snapshot's three K10 suites **27/27 PASS**;
  #1142 source's three K10 suites **35/35 PASS** after the D-060 parser
  change; static smoke **34/34 PASS**. These are **local**, not hosted/new-HEAD
  CI. Real Playwright/320–1440 capture, keyboard/focus, Windows user PC,
  OAuth/pairing and native consent remain **NOT_RUN**. No merge, issue close,
  workflow change, or new PR is authorized by this report.
