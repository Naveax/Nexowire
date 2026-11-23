# NX AI-06 · CORE status UI handoff · 2026-11-23

## Ownership / baseline
- Integration PR: #1160; baseline commit: `83c8b651106ecd1244fb9d982cf94fd390c15b6b`.
- Branch: `agent/nx-06-core-status-ui-20261123`; scoped files: `web/connect.js`, `web/connect.html`, `web/styles.css`, `test/ui/ai06-core-status.test.ts`, `test/ui/ai06-delegated-compat.test.ts`, `test/connect-web.test.ts`, `test/delegated/k01/connect-state.test.ts`, `test/delegated/k06/connect-error-display.test.mjs` and this AI-06 handoff.
- No shared workflow, provenance, Broker, authority, Windows task, credential or SQLite changes.

## Contract
- A successful account/session check and pairing only proves account pairing readiness. It **does not** assert CORE authority or elevated effects.
- The UI renders `NOT_INSTALLED`, `PERMISSION_REQUIRED`, `AWAITING_PHYSICAL_ACCEPTANCE`, `REVOKED_LOCALLY`, `BROKER_RUNNING_BUT_UNVERIFIED`, `READY_VERIFIED`, and `UNKNOWN`, with Turkish/English copy.
- Any unavailable, malformed, unmatched or unevidenced dashboard state remains `UNKNOWN` instead of being inferred from device online, HTTP 401, Broker Running, account pairing or preference toggle.
- Explicit negative states are from named dashboard fields; `enrollmentRequested` and `physicalConsole` are read-only. The current authority's actual `deviceStatus()` supports `enrollmentRequested`, `localEnrolled`, `deviceReady`, `active` and `observedAtMs`. `installationStatus`, `permissionRequired`, and local `state` are forward-compatible optional fields, **not** a claim that the server currently emits them.
- `READY_VERIFIED` remains unreachable while `CORE_INDEPENDENT_VERIFIER_INSTALLED=false` (same independent-verifier limitation already present in `web/app.js`): a JSON dashboard assertion, even with `active:true`, is **not** an independent protected Windows proof. Coordinator/AI-03 must supply a reviewed attested status and enable the latch in an authorized change.
- The pairing POST is single-flight. On 503, network/ACK loss or malformed success response, the UI blocks replay and explicitly instructs checking the local outcome. No automatic retry of an `UNKNOWN` mutation.
- Pairing remains enabled even when CORE status is unknown or revoked; CORE is a separate owner-consent flow.

## Validation
- Focused source/VM test: `node --test --import tsx test/ui/ai06-core-status.test.ts`.
- DOM/retry regression: `node --test test/delegated/k06/connect-error-display.test.mjs`; legacy web copy contract: `node --test --import tsx test/connect-web.test.ts`.
- Existing source/VM test: `node --test --import tsx test/connect-onboarding.test.ts`.
- Existing DOM contract: `node --test --import tsx test/console-ui-polish.test.ts`.
- Browser checks still required on real browsers: 320/375/768 CSS pixels, zoom 200%/400%, keyboard-only tab navigation, reduced motion, forced colors, English and Turkish, various network outcomes. CSS or VM-only assertions are **not** browser acceptance.
- Exact-SHA CI runs must be observed after Draft PR, **not** borrowed from #1160.
- Source/DOM: prior exact-head `48a0fda89dd020f257cd5e8d944d9c9b4fab4d2b` CI #45206150272 **SUCCESS** (Node 22/24, delegated 409, build). New commits require their own exact-SHA revalidation. Live `connect.html` browser accessibility: NOT_RUN; generic `browser-live` CI uses a separate fixture. Physical SYSTEM/CORE/DPAPI/Windows: NOT_RUN by AI-06.

## Rollback
- Revert only these AI-06 commits or close this Draft PR. No production/device rollback is necessary because no live services or stored states were modified.

## 2026-11-23 CI triage and current source-only evidence
- Prior SHA `c9b162a7d1f7da988b11da7e1980ef69e0f3b529` CI #45182074096 was FAILURE only after `npm run check` PASS: Node24 delegated source+transfer batch red, Node22 cancelled. Do not inherit earlier SHA PASS.
- K06 delegated `connect-error-display` previously expected 503 retry despite uncertain POST completion. It now enforces no-repeat and secret redaction; legacy error wording remains visible as an accurate generic prefix.
- A source-only in-memory V8 simulator ran pairing 403, 503, 502, invalid 200 and network loss, with one POST even after duplicate clicks. These checks are **not** full Node/hosted browser acceptance.
- Further newly committed status/timeout regressions await exact-SHA CI. No claims of CI PASS until green on the final SHA.
- AI-05/coordinator should revise `docs/INSTALL_WINDOWS.md` and `docs/CHATGPT_INSTALL_PROMPT.md` recovery wording and their mixed docs-only tests for UNKNOWN outcome vs new locally-initiated session, without replacing existing credential redaction.

## Coordination blockers
1. Reviewed independent native owner/elevated verifier is not deployed; `READY_VERIFIED` must remain disabled.
2. Two-PC physical owner acceptance and real effect/revoke require AI-09 with explicit local administrator consent.
3. No browser-live result is claimed without an executable browser run on the exact source SHA.

## 2026-11-23 K01 delegated regression correction

- Actual blocker was the nested `test/delegated/k01/connect-state.test.ts` DOM fixture asserting the legacy `Hazır` UI and retrying an uncertain 503 pairing POST. Those assertions are no longer correct for an idempotency-safe interface.
- K01 DOM fixtures now require `Eşleştirmeye hazır` (account pairing only), one POST with terminal uncertain local readback guidance after 503, no subsequent automatic re-send, and a separately initiated fresh session positive flow.
- Exact-source CI `a334bd4c3b0404e28f6006836b1e458c2ddf5c56`: Node22 and Node24 both completed `npm run check` and the explicit **409-case delegated lane** successfully during observed jobs; physical acceptance remains NOT_RUN.
- The temporary full 409-test duplicate diagnostic was **replaced** by a bounded four-file test `test/ui/ai06-delegated-compat.test.ts`, which additionally exercises the 19 K01 DOM cases under the ordinary Node check (35 nested tests total). This avoids retaining a second complete 409-case lane.
- This is a pure DOM/contract regression update, not authority or security policy mutation. Other agents retain ownership of their production source and CI/provenance.
- The current branch requires a new exact-head CI result after the diagnostic cleanup; do not inherit historical PASS onto the final SHA.

## 2026-11-23 Follow-up: offline and malformed dashboard states

- `BROKER_RUNNING_BUT_UNVERIFIED` is now shown only with a single matched Windows device that is explicitly online and has broker/bridge metadata. An offline saved `privilegeMode:broker` configuration is `UNKNOWN`, **not** proof that the Broker is running.
- Conflicting duplicate dashboard entries with the same device ID are `UNKNOWN` rather than depending on whichever list element came first.
- `enrollmentRequested` does **not** establish local delivery. Pending copy explicitly says the request was recorded without proof the PC received it or its owner approved UAC.
- The CORE description remains the sole live status region; the visible status code is described by the TR/EN text instead of generating an extra competing live announcement.
- These are UI-only changes. The read-only backend shape still cannot assert `REVOKED_LOCALLY` without a future explicit owner-attested negative field; `READY_VERIFIED` remains disabled.
- Additional VM tests exercise offline/missing-online device metadata, duplicate IDs, recorded-but-undelivered requests, and accessible status regions. Actual screen-reader and 200%/400% zoom results remain NOT_RUN.
