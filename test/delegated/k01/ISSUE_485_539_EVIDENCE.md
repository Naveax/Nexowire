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

## P006 T-535…T-539 — same-source RED / proposal GREEN (8 Nov 2026)

**Source provenance:** upstream main now
`52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`; UI `web/connect.js`
retains blob `a417a2715333ab555cbda25d1b3c020aa19d8b6a`.
Owner Draft [#1068](https://github.com/Naveax/Nexowire/pull/1068)
remains at `94d38799e9e4b50fe84f7924e6fc84f90aeba090` with UI blob
`5618fd2a8a1bdfcd5d7e1a2ef7db688b8ed3eda1`.

**T-535:** The actual owner `connect.js` receives a synthetic blank
`pairingId`/`token` HTTP 200 response; original source navigates (RED).
The test then runs an **in-memory replacement only** requiring
`!value.trim()`; the blank results show `Hata` without navigation, and a
valid ID/token still navigates (candidate GREEN). No owner source file
changed; no production fix or device acceptance is claimed.

**T-536:** 429 with `Retry-After: 15` still presents exactly the same
generic message as 503 (RED). A test-only in-memory candidate adds a
different rate-limit message with a bounded 15-second display hint and
leaves 503 generic (candidate GREEN). No actual retry timing or server
rate limiting was changed; owner #1068 chooses final behavior.

**T-537:** GitHub's latest release is
[v1.0.8](https://github.com/Naveax/Nexowire/releases/tag/v1.0.8),
but the connection screen intentionally pins installer commit
`96315d5dd4986fffbd24a96859309271d2a88ffe`. Its
`installers/Nexowire-Setup.cmd` blob
`8f7880123a0e21e345fcd1d9299514a0cc965c2b` explicitly sets
`NX_VERSION=1.0.7` and downloads v1.0.7. UI CTA says v1.0.7 and
does not claim to install v1.0.8/latest (**PASS source/VM**).
K06 documentation can clarify pinned tested installer versus latest
release; modifying installer binaries is release-owner work.

**T-538:** A successful synthetic POST holds the in-page click handler
busy while callback navigation is requested; a second click yields no
second POST or navigation (**PASS source/VM**). Actual out-of-order
responses across sessions, tabs or live requests are **NOT_RUN**.

**T-539, new opt-in RED:** A synthetic fetch rejection containing a long
Unicode fixture token is directly exposed in
`error-message.textContent` via raw caught `error.message`, on both main
and #1068. This source-level display gate **FAILS**. It does **not**
prove that native browser fetch errors or live backend replies include
tokens. Owner can map known actionable exceptions to user-safe messages
and use a generic fallback for unexpected diagnostic details; K01 may
not modify auth, tokens, logging or owner web source.

### Repeatable local commands and results

```sh
node --test test/delegated/k01/issue485-state-truth.test.mjs
# main: 19 tests / 13 PASS / 6 SKIP / 0 FAIL
K01_CONNECT_REF=FETCH_HEAD K01_EXPECT_OWNER_VERSION=1 node --test test/delegated/k01/issue485-state-truth.test.mjs
# owner #1068: 19 tests / 16 PASS / 3 SKIP / 0 FAIL
K01_RUN_OPEN_NEGATIVES=1 node --test test/delegated/k01/issue485-state-truth.test.mjs
# main: 13 PASS / 3 SKIP / 3 FAIL (blank pairing, 429, raw error token)
K01_CONNECT_REF=FETCH_HEAD K01_RUN_OPEN_NEGATIVES=1 node --test test/delegated/k01/issue485-state-truth.test.mjs
# owner #1068: 13 PASS / 3 SKIP / 3 FAIL (same three)
```

Previous exact HEAD `25f505f0fa36d52ec3ea0c23674a1d92de4a2df9`
had [seven-job CI success](https://github.com/Naveax/Nexowire/actions/runs/42473583303).
However the K01 nested `.test.mjs` is **not selected by the required CI**;
new fixtures were run locally, **hosted NOT_RUN** unless an explicit
per-file runner proves execution on exact HEAD. Real Windows/Agent/Hub,
browser screenshots, device pairing/loopback listener **NOT_RUN**.

## P007 D-001…D-006 — PR consolidation evidence (8 Nov 2026)

**PR inventory and path ownership (D-001).** Source PR
[#1011](https://github.com/Naveax/Nexowire/pull/1011)
exact HEAD `6e740dfe919e5f615655f68815b078447915ce6f`
has four changed paths. All **four** file blobs are **byte-identical**
to owner Draft [#1068](https://github.com/Naveax/Nexowire/pull/1068)
HEAD `94d38799e9e4b50fe84f7924e6fc84f90aeba090`:

| Path | Matching SHA in both PR heads |
| --- | --- |
| `web/connect.js` | `5618fd2a8a1bdfcd5d7e1a2ef7db688b8ed3eda1` |
| `web/connect.html` | `1fdbe1c4d3e8cf92a3dbaddc06ecb7dbbcaa6c24` |
| `test/delegated/k01/connect-state.test.ts` | `3a8ea6a60c0896021a4dce3d28d62ab4efe52bdb` |
| `test/delegated/k01/ACCEPTANCE.md` | `f1af623799d264fbaf79bee9d12788fa8194ef41` |

Therefore **#1011 has no unique content to preserve by copying files**.
Its standalone merge would conflict with #1068 web ownership. Preserve
the owner-integrated blobs and keep the distinct #1114 negative tests
on the existing #1114 branch. Recommend **closing redundant Draft #1011
only after owner/ŞEF confirmation**, not unilateral closure or merge.

**D-002:** Both current main `52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`
and owner #1068 (exact SHA above) still present three source-level
RED gates: blank pairingId/token, 429 vs 503 identical error text, and
raw exception text in DOM. Their associated test-only in-memory proposals
are GREEN for the narrow stimuli; no owner source was changed.

**D-003, new RED:** The original owner `connect.js` completes dashboard
200 then, if the pairing POST returns **401 SESSION_EXPIRED**, shows
the identical generic `Bağlantı hazırlanamadı.` retry text as a 503
service outage. Its 403 quota denial *does* get a terminal message
with retry disabled in owner #1068. A new opt-in test enforces that 401
and 503 explain different user actions: it **FAILS** on main and owner.
The appropriate login/expired-session decision is auth-owner work;
K01 only supplies UI evidence and no auth flow changes.

**D-004, actual hosted CI:** #1011 HEAD `6e740df` had
[run 41337712422](https://github.com/Naveax/Nexowire/actions/runs/41337712422)
`completed/action_required` and **zero jobs**; this is NOT_PASS.
#1114 prior HEAD `0366113952f8a006432a3370ffc4933fc4c9f40d`
had [run 42485193172](https://github.com/Naveax/Nexowire/actions/runs/42485193172)
`completed/success`, seven jobs; nevertheless required CI workflow blob
`90185b6f4297bc3e4feaca44817ed6a8248bd4be` does not call
`test/delegated/k01/issue485-state-truth.test.mjs` or even its directory.
Thus **K01's new .mjs is hosted NOT_RUN**. K13 owns auxiliary test
discovery; upstream ci.yml remains owner #1096.

**D-005, exact owner request:** on `web/connect.js` blob `5618fd2a`:

1. Reject empty/whitespace pairingId and token strings (the test already
   proves valid pairing continues to navigate after candidate validation).
2. Give 429 with valid bounded Retry-After distinct, actionable text
   from 503, keeping terminal 403 distinct.
3. Pairing 401 should offer a session-expiry or reauthentication path,
   rather than suggesting another identical transient-service retry.
4. Do not copy unexpected exception diagnostics verbatim to the DOM;
   preserve user-facing known errors and generic fallback for unknowns.

These are **proposals**, not source changes or claims that live services
sent the synthetic payloads.

**D-006 acceptance/closure recommendation:** #1114 remains Draft with
intentional failing opt-in tests, hosted test discovery NOT_RUN, and
real keyboard/375-768px screenshots/Windows/two-device/onboarding
NOT_RUN. Retain #1114 until owner fixes plus exact-source tests and
CI discovery are verified; do not merge or close issue #485/#539.
For #1011, get owner/ŞEF signoff to close it as redundant once #1068
will carry the identical four blobs. No unilateral PR closure.

New local test totals: main **20 tests / 13 PASS / 7 SKIP**; owner
**20 / 16 PASS / 4 SKIP**. Opt-in RED main and owner **13 PASS / 3 SKIP /
4 FAIL** (pairing blanks, 429, raw exception, pairing 401). Host exact
HEAD for any following commit must be checked again; no rerun of existing
same-SHA workflows.

## D-005 follow-up — reproducible UI fallback candidate (8 Nov 2026)

After the P007 duplicate-PR audit, two further **in-memory-only** source
proposals were exercised on pinned main and owner #1068:

1. **Pairing POST 401** is genuinely identical to 503 in the original
   source. The candidate displays a session-expiry and re-login hint for
   401, while leaving the 503 message unchanged. This is only a message
   example, **not** an auth/session change or proof that a live 401 occurs.
   Authorization behavior remains with its owner.
2. **Unexpected exception text** can contain a synthetic token, which is
   copied into the DOM by the original catch handler. The candidate
   preserves four known user-safe messages, sends an unexpected diagnostic
   to a generic user message and does not copy the fixture secret into the
   DOM. It is a narrow sample policy, not a production allowlist or
   security review. Owner must review future error contracts.

The two tests assert original source **RED in behavior**, proposed source
**GREEN in the VM**, and do not write any `web/connect.js` content.
No auth tokens, backend data, release or protected source were modified.

```sh
node --test test/delegated/k01/issue485-state-truth.test.mjs
# main 22 tests: 15 PASS / 7 SKIP / 0 FAIL
K01_CONNECT_REF=FETCH_HEAD K01_EXPECT_OWNER_VERSION=1 node --test test/delegated/k01/issue485-state-truth.test.mjs
# owner 22 tests: 18 PASS / 4 SKIP / 0 FAIL
K01_RUN_OPEN_NEGATIVES=1 node --test test/delegated/k01/issue485-state-truth.test.mjs
# main 15 PASS / 3 SKIP / 4 FAIL (the original 4 owner gaps)
K01_CONNECT_REF=FETCH_HEAD K01_RUN_OPEN_NEGATIVES=1 node --test test/delegated/k01/issue485-state-truth.test.mjs
# owner 15 PASS / 3 SKIP / 4 FAIL (same gaps)
```

Previous HEAD `e539348e209cd007d4e094a4eca99d49aebe7945`
[CI run 42500485458](https://github.com/Naveax/Nexowire/actions/runs/42500485458)
finished **success** for seven generic jobs, but still did not select
the nested K01 `.test.mjs`. Explicit hosted K01 test invocation remains
**NOT_RUN**; source fix, owner signoff and real browser are pending.

## T-260: real browser attempt and blocker

`browser-capture.mjs` serves the three web source files through an isolated
127.0.0.1-only fixture and tries Chromium headless screenshots for install,
ready and error across 375px/768px/desktop. No real credentials or Agent.

In the current Linux execution environment Chromium 156 failed before page
load: `singleton_posix.cc:297 Check failed: . socket() failed: Operation not permitted (1)`;
therefore **zero screenshots / real browser focus / viewport acceptance**.
Do not treat successful Node VM tests as browser PASS. A permitted Chromium
runner or independent K10 browser environment is needed for T-260.
