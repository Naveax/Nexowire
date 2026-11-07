# K01 — Issue #485 / #539 R01-R11 source-only evidence (7 Nov 2026)

## P004 T-255: exact source comparison

| Source | HEAD | `web/connect.js` blob | `web/connect.html` blob |
| --- | --- | --- | --- |
| `Naveax/main` | `4e7db16f4233048a956664bef6b607781eb63fb7` | `a417a2715333ab555cbda25d1b3c020aa19d8b6a` | `8810145a37d25dcb3d6eef89b93161228a6edf7a` |
| [Draft #1011](https://github.com/Naveax/Nexowire/pull/1011) | `6e740dfe919e5f615655f68815b078447915ce6f` | `5618fd2a8a1bdfcd5d7e1a2ef7db688b8ed3eda1` | `1fdbe1c4d3e8cf92a3dbaddc06ecb7dbbcaa6c24` |
| [Owner Draft #1068](https://github.com/Naveax/Nexowire/pull/1068) | `94d38799e9e4b50fe84f7924e6fc84f90aeba090` | `5618fd2a8a1bdfcd5d7e1a2ef7db688b8ed3eda1` | `1fdbe1c4d3e8cf92a3dbaddc06ecb7dbbcaa6c24` |

Owner #1068 also includes the exact #1011 `test/delegated/k01/connect-state.test.ts`
blob `3a8ea6a60c0896021a4dce3d28d62ab4efe52bdb`. Those paths are
already owned by an unmerged coordinator PR. **Do not update them from K01.**

Main still exposes these presentation gaps: quota/403 maps to an enabled
TEKRAR DENE; the terminal account error receives no explicit focus; MCP
discovery timeout and aborted request share a generic failure message. The
candidate owner version changes these behaviors, but remains Draft and is
not accepted on `main`. This is a source difference, **not** physical proof.

## T-256…T-259: additive, independent negative tests

New file `issue485-state-truth.test.mjs` uses offline `node:vm`, stubbed DOM
and synthetic `fetch`, with **no** live Hub, Agent, OAuth or device. It tests:

- dashboard 500/503 and 401 never issue a pairing POST or show connected;
- dashboard 200 means only `Hazır`/approval, even with an offline device in
  the fixture, never proof of a remote Agent connection;
- in-flight double-click issues one POST; rejected retry is serial;
- metadata 503, invalid address, timeout and abort never enable guessed MCP URL;
- unsafe/non-loopback callbacks never request dashboard or pairing;
- malformed successful-looking pairing data never navigates/claims success.

Reproduce on pinned `main`:

```sh
node --test test/delegated/k01/issue485-state-truth.test.mjs
```

Results on `main@4e7db16` with Node 24.22.1: **7/7 PASS**.
Also tested against owner PR #1068 exact HEAD by fetching the PR into
`FETCH_HEAD` and running:

```sh
K01_CONNECT_REF=FETCH_HEAD node --test test/delegated/k01/issue485-state-truth.test.mjs
```

Result: **7/7 PASS**. `git rev-parse FETCH_HEAD` was verified equal to
`94d38799e9e4b50fe84f7924e6fc84f90aeba090` in this run.

**Limits:** Tests are independent source contracts, not actual disconnected
device health/reconnect/UNKNOWN lifecycle acceptance. T-256 and T-257 remain
partial for physical/UI semantics; T-258 and narrow T-259 are offline-covered.
Issue #485's signed installer, native pairing/recovery and #539's multi-layer
error-origin contract remain separate protected owner work.

## T-260: real browser attempt and blocker

`browser-capture.mjs` serves the three web source files through an isolated
127.0.0.1-only fixture and tries Chromium headless screenshots for install,
ready and error across 375px/768px/desktop. No real credentials or Agent.

In the current Linux execution environment Chromium 156 failed before page
load: `singleton_posix.cc:297 Check failed: . socket() failed: Operation not permitted (1)`;
therefore **zero screenshots / real browser focus / viewport acceptance**.
Do not treat successful Node VM tests as browser PASS. A permitted Chromium
runner or independent K10 browser environment is needed for T-260.
