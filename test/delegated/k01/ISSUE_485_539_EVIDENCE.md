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

## T-257 owner gates and T-259 new negative (adım 4)

Added three opt-in tests with visible `skip` markers in the default suite.
This keeps known-unfixed source behavior from becoming a false green while
providing an executable red test for a future owner fix.

1. On owner #1068, `K01_EXPECT_OWNER_VERSION=1 K01_CONNECT_REF=FETCH_HEAD
   node --test test/delegated/k01/issue485-state-truth.test.mjs` yielded
   **9 PASS / 1 SKIP / 0 FAIL**. The two extra owner-only gates checked
   quota `403` disables retry and terminal account errors focus the alert.
2. **Confirmed source gap**, in current main **and** owner #1068:
   `web/connect.js` validates only that `body.pairingId` and `body.token`
   have JavaScript type `string`. Empty `pairingId`, empty `token`, and
   both empty, and whitespace-only values still trigger a loopback callback
   navigation after HTTP 200.
   That is a false accepted-response boundary, *not* evidence that server
   issues empty credentials or that an attacker exploited it.
3. Run the opt-in negative with
   `K01_RUN_OPEN_NEGATIVES=1 node --test
   test/delegated/k01/issue485-state-truth.test.mjs`.
   Against **main** and **#1068**, result **7 PASS / 2 SKIP / 1 FAIL**;
   the failing assertion enumerates all five blank-field variants. This
   result is **FAIL, not PASS**. The normal suite reports
   **7 PASS / 3 SKIP / 0 FAIL**.

Smallest proposed owner-side fix: reject blank or whitespace-only
`pairingId`/`token` strings before callback navigation, with HTTP 200
negative test coverage. K01 does not patch `web/connect.js` while owner
#1068 controls that path. Existing validation of callback origin, state
and device identity must remain intact.

## P005 T-395…T-398 — paired controls and additional source evidence (8 Nov 2026)

Upstream `main@b5a3f8840517d65ecbd6a018699c4c8bdde09987` contains
the unchanged `web/connect.js` blob `a417a2715333ab555cbda25d1b3c020aa19d8b6a`;
the active owner [#1068](https://github.com/Naveax/Nexowire/pull/1068)
remains Draft at `94d38799e9e4b50fe84f7924e6fc84f90aeba090` with blob
`5618fd2a8a1bdfcd5d7e1a2ef7db688b8ed3eda1`. No owner source code
was changed by this PR.

### T-395: one positive, five negative payloads

The opt-in negative **first** verifies a fully specified HTTP 200 pairing
response (`pairingId='pair-395', token='value-395'`) yields exactly one
127.0.0.1 callback containing the expected `state`, ID and token. It then
requires **zero** callback navigations and an explicit error for each of
five invalid cases: empty ID, empty token, both empty, whitespace ID and
whitespace token. The five cases still **FAIL** on both main and #1068.
This pairing of a valid control and invalid controls guards against the
misleading workaround of blocking all callback navigation.

Minimal owner recommendation, immediately after `const body = await pairing.json()`:

```js
if (!body ||
    typeof body.pairingId !== 'string' || !body.pairingId.trim() ||
    typeof body.token !== 'string' || !body.token.trim()) {
  throw new Error('Bağlantı cevabı geçersiz.');
}
```

The blank-string source gap is **not** a demonstrated live Hub behavior or
an authorization exploit. #1068 owner must decide whether to apply the
source fix, then turn the gated test into a regular required regression.

### T-396: stale dashboard 401 versus pairing

In the real `connect.js` control flow, `loadAccount()` **awaits** the
dashboard response before attaching the click handler. A delayed 401
fixtures the original button as disabled, then redirects to GitHub auth
without any pairing POST or click handler. **PASS for this narrow single-page
race**, not proof of cross-tab or live network sequencing.

### T-397: callback authority and missing context

Seven negative query fixtures reject lookalike hosts, user-info callback
URLs, wrong callback path and absent state/device identity/name. None
performs dashboard or pairing requests, navigates, or claims connected.
**PASS source/VM**. Real loopback listener identity/provenance cannot be
proved by this browser page; actual device approval is **NOT_RUN**.

### T-398: 403/429/503 semantic distinction

On owner #1068, device quota HTTP 403 disables retry with a specific
message, unlike generic 503 (**owner-only PASS**). A new opt-in **RED**
fixture shows both HTTP 429 with `Retry-After: 15` and 503 produce the exact
same generic `Bağlantı hazırlanamadı.` message. No observed 429 delay is
communicated. This is a **source/UI communication gap**, not evidence that
the upstream endpoint currently emits a 429; only owner #1068 may alter
`web/connect.js` before merge. Suggest a distinct rate-limit message,
honoring bounded server Retry-After semantics in the owner design.

### Commands and observed outcomes

```sh
node --test test/delegated/k01/issue485-state-truth.test.mjs
# main: 14 tests / 9 PASS / 5 SKIP / 0 FAIL
K01_CONNECT_REF=FETCH_HEAD K01_EXPECT_OWNER_VERSION=1 node --test test/delegated/k01/issue485-state-truth.test.mjs
# owner #1068: 14 tests / 12 PASS / 2 SKIP / 0 FAIL
K01_RUN_OPEN_NEGATIVES=1 node --test test/delegated/k01/issue485-state-truth.test.mjs
# main: 9 PASS / 3 SKIP / 2 FAIL (T-395 and T-398 remain RED)
K01_CONNECT_REF=FETCH_HEAD K01_RUN_OPEN_NEGATIVES=1 node --test test/delegated/k01/issue485-state-truth.test.mjs
# owner: 9 PASS / 3 SKIP / 2 FAIL (same RED)
```

The previous #1114 HEAD `3808997566139a56bb6f60f479932c91451e600b`
has [CI run 42411724295](https://github.com/Naveax/Nexowire/actions/runs/42411724295)
**completed/success** (seven jobs). However upstream `.github/workflows/ci.yml`
does **not** explicitly execute `test/delegated/k01/issue485-state-truth.test.mjs`,
and its `npm test` path discovers `.test.ts`, not nested `.test.mjs`. Thus
the **new K01 test itself was NOT_RUN in hosted CI**, despite an overall
green CI status; the offline commands above were executed locally. The
new commit needs its own exact-HEAD CI assessment. No existing run was
manually restarted.

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
