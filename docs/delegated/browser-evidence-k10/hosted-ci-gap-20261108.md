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
  renders three **synthetically labelled** layout states at the 375/768/1440
  viewport matrix. It hashes output PNGs, checks decoded pixels/dimensions,
  rejects repeated image content, a supplied SHA unlike `git rev-parse HEAD`,
  and horizontal overflow. It cannot create
  an authenticated success state or test the real device/keyboard behavior.
- No Playwright version/browser is bundled or silently downloaded. On a runner
  without Playwright, script returns `NOT_RUN` with exit 2. Actual optional
  capture remains **NOT_RUN** until a properly equipped runner runs it.

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
