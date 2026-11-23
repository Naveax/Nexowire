# NX AI-06 · CORE status UI handoff · 2026-11-23

## Ownership / baseline
- Integration PR: #1160; baseline commit: `83c8b651106ecd1244fb9d982cf94fd390c15b6b`.
- Branch: `agent/nx-06-core-status-ui-20261123`; only `web/connect.js`, `web/connect.html`, `web/styles.css`, `test/ui/ai06-core-status.test.ts` and this AI-06 handoff are modified.
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
- Existing source/VM test: `node --test --import tsx test/connect-onboarding.test.ts`.
- Existing DOM contract: `node --test --import tsx test/console-ui-polish.test.ts`.
- Browser checks still required on real browsers: 320/375/768 CSS pixels, zoom 200%/400%, keyboard-only tab navigation, reduced motion, forced colors, English and Turkish, various network outcomes. CSS or VM-only assertions are **not** browser acceptance.
- Exact-SHA CI runs must be observed after Draft PR, **not** borrowed from #1160.
- Source/DOM results: NOT_RUN until executed. Live browser: NOT_RUN. Physical SYSTEM/CORE/DPAPI/Windows: NOT_RUN by AI-06.

## Rollback
- Revert only these AI-06 commits or close this Draft PR. No production/device rollback is necessary because no live services or stored states were modified.

## Coordination blockers
1. Reviewed independent native owner/elevated verifier is not deployed; `READY_VERIFIED` must remain disabled.
2. Two-PC physical owner acceptance and real effect/revoke require AI-09 with explicit local administrator consent.
3. No browser-live result is claimed without an executable browser run on the exact source SHA.
