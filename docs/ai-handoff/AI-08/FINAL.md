# AI-08 | Final handoff (pre-CI snapshot)

- **Durum:** `NO_GO` for production / `IN_PROGRESS` for independent QA. Do not promote to READY_FOR_REVIEW until exact AI-08 HEAD CI is inspected.
- **Branch:** `ai/08-independent-qa-20261031`
- **Base:** #984 `local/persistent-enrollment-v2-20261031` at `9d0f35607d4cde87bd031e2da77855cfaf570c31` (stacked via #983, #982, #981, #980 → main).
- **Final Head SHA:** will be obtained after all files are committed. No commit can truthfully predeclare its own SHA.
- **Draft PR URL:** pending; reported separately after creation.
- **Changed files:** only five new `test/ai08-*.test.ts` and five `docs/ai-handoff/AI-08/*.md`. No production code changed.
- **Test command / exit code:** `node --test --import tsx test/ai08-*.test.ts`, `npm run typecheck`, `npm run build`: **NOT_TESTED** at writing. No local checkout/npm deps due GitHub DNS restriction.
- **Source reference CI:** base #984 run 41145160595, exact `9d0f35607d4cde87bd031e2da77855cfaf570c31`, SUCCESS. This is NOT an AI-08 HEAD run.
- **AI-08 exact CI ID:** pending new PR workflow; do not trigger a duplicate for the same SHA/workflow/inputs.
- **Negatives:** synthetic WAL/crypto/CAS/enrollment/sandbox and disposable local TLS cases defined in `TEST_EVIDENCE.md`. Actual PASS/FAIL requires measured CI.
- **Mock / actual OS / physical:** tests use SYNTHETIC_UNIT, DISPOSABLE_SQLITE and LOCAL_TLS_LOOPBACK, no trusted native Windows proof, NO physical two-PC acceptance.
- **Integration:** see `INTEGRATION_REQUEST.md` for #03/#07 native isolation, D1 claim/CORE readback, durable CAS and two-device checks. No direct external module edits.
- **Open P0 / residual:** #539 reliability open; #974 WAL open for broader acceptance, sandbox native handoff not integrated; #949/#946 adversarial PRs RED at their own HEAD; CORE production remains fail-closed NO_GO.

This snapshot is intentionally conservative. Post-CI exact run details belong in a dated PR comment/handoff revision with **its own** exact HEAD SHA; prior SHA evidence must not be silently reused.
