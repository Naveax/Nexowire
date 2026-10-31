# AI-04 TEST EVIDENCE | 2026-10-31

## Exact source candidate
- Repo/PR: `Naveax/Nexowire` [Draft #987](https://github.com/Naveax/Nexowire/pull/987); base `7e4093c30c1ead3cd22888184450c34aef4737da`.
- Source SHA: `b4b1cbf57d40b2f16926f132b435837a527d5e07`; [CI #41200010652](https://github.com/Naveax/Nexowire/actions/runs/41200010652).
- Verified source run completed SUCCESS 7/7. Hosted Windows `Compile native Windows Job guardian` and `Physical Windows Job Object regressions` steps SUCCESS. Real equal-HIGH/UAC-linked adversarial probes remained BLOCKED; this is not physical acceptance.
- Exact earlier source SHA `84845566bde5b4def4cb58bec90296fb011793c5`, CI `41198157070` completed SUCCESS 7/7, independent of current candidate.
- `npm run typecheck` on Node 22/24 CI: exit 0. `npm test` Node 22 CI exit 0, 2765 tests / 2411 pass / 0 fail / 352 skipped / 2 todo. `npm run build` exit 0 on both Node matrices.
- New tests in current source: `test/ai04-broker-binding-snapshot.test.ts` 5, `test/ai04-broker-job-handle-inheritance.test.ts` 2, `test/ai04-broker-protected-witness-snapshot.test.ts` 9, `test/ai04-broker-signed-json-canonical.test.ts` 9. All 25 stand-alone AI-04 tests PASS on Node 22/24. Plus `test/broker-dispatch-authority-handler.test.ts` validly signed noncanonical receipt negative PASS, total 26 new/incremental tests.
- New signed-wire tests: canonical positive; signed whitespace, duplicate-key, alternate-escape and invalid UTF-8 negatives at RESERVED and COMMITTED (8); server-side signed noncanonical JSON rejected via HTTPS handler (1).
- Hosted Windows native MSVC/Job regression steps were SUCCESS in source runs `41196171288`, `41198157070` and the ongoing current source run at authoring. CI-hosted Win32 kernel readback is not owner-PC physical admission.
- Local clone / local Windows execution: NOT RUN (no GitHub network checkout in assistant sandbox); local exit code N/A.

## Physical/OS limitations
- Current hosted runner `41200010652` (and earlier `41194719016`) reported `BLOCKED: SeDebugPrivilege is enabled; equal-HIGH isolation cannot be accepted`.
- Real equal-HIGH same-logon Job duplicate-handle test SKIP/BLOCKED: `NX_MEDIUM_HIGH_PROOF_BLOCKED attacker_token_not_high_or_debug_enabled`.
- UAC-linked Medium attacker test SKIP/BLOCKED: `NX_MEDIUM_HIGH_PROOF_BLOCKED linked_token_unavailable`.
- Even after sealing guardian DACL, a stolen Job handle in the pre-seal window remains P0 open; real isolated principal/SID and protected IPC is a separate requirement.
- Protected installed Broker/token/owner grant, independent durable one-use CAS and revoke drain, UAC/ACL physical scope, user's two authorized Windows PCs: NOT TESTED. **CORE production NO_GO**.

## Historical source checkpoints
- #950 `4c92f676c5d0ce0dd6c85a6288912ab21bf4a80c`: CI `40752196776` SUCCESS 7/7.
- #952 `c6383530364ae7765982a988aed54d3c9a093752`: isolated PR HEAD had no workflow run verified at initial inspection.
- #980 base `7e4093c30c1ead3cd22888184450c34aef4737da`: CI `41113730982` SUCCESS.
- Earlier AI-04 source commits `c5fb0e424cc30e2adaaa2dec9235d62eb6a4ce4d` CI `41194719016` SUCCESS, `62f73e1ddfa4c7fc8ebadcd7b7499393a66cc380` CI `41196171288` SUCCESS, `84845566bde5b4def4cb58bec90296fb011793c5` CI `41198157070` SUCCESS.

## Yeni identity/readiness değişikliği: CI PENDING
- `test/ai04-broker-identity-race.test.ts` 5 sentetik test eklendi: stabil kapsam + begin CAS sırasında scope kaybı + commit CAS sırasında scope kaybı + iki identity provider UNKNOWN aşaması. Eski `bcdb6be4d446aaa70023ef7ff87f9764d0df503e` / `41201230598` SUCCESS yeni kaynağın kanıtı değildir.
- Remote CAS atomik revoke, gerçek owner SID ve native OS readback kanıtı mevcut değildir; bunlar ayrı BLOCKED kapılar olarak korunur.

## 2026-11-01 | Latest source and newly staged tests

- Önceki exact-source SHA `46909dd677188396646681605959792ae81091e3`; CI `41243950808` **SUCCESS 7/7**, Node22 2,774 / 2,420 PASS / 0 FAIL / 352 SKIP / 2 TODO. Windows fixture 27/27, native guardian MSVC + Job regressions steps SUCCESS, physical equal-HIGH and UAC-linked negative probes BLOCKED.
- Signed claim envelope source SHA `d971f0239d3d2b76b406697aac0183cbdea60097` CI `41246475485`; Node22 and Node24 jobs PASS, source-only 11 new receipt object tests PASS. Node22 2,785 tests / 2,431 PASS / 0 FAIL / 352 SKIP / 2 TODO. Windows browser-live in_progress at preparation time. Never extrapolate 7/7.
- Latest pinned constructor callback candidate source SHA `0ce89fce32252ba84478472f3fc9d479156ee18c`: add `test/ai04-broker-config-snapshot.test.ts` four negative mutation/retarget/accessor/Proxy tests. **No passing CI is yet attributed to this candidate or following docs commit**. Required checks: Node22/24 typecheck, build, full tests and Windows browser-live physical Job native/MSVC fixture. Changed only AI-04 paths.
- `npm run typecheck`, `npm test`, `npm run build`: previously recorded successful GitHub runner exit 0 applies only to corresponding exact prior SHA. This new source+doc SHA is not yet verified; local Windows physical exit code N/A, not run. No user device touched.
- All source-only positive/negative results remain distinct from protected OS/owner/session/real independent CAS, kernel handle/descendant and two-PC physical acceptance. Physical CORE NO_GO.

## AI-04 exact-SHA Node22 two red root-cause evidence
[CI 41249550536](https://github.com/Naveax/Nexowire/actions/runs/41249550536), HEAD `8ae78075f2f1c6fbb1f314aa6c38ae6daf36d24a`: Node22 2 FAIL, 2817 total, 2461 PASS, 352 SKIP, 2 TODO. `test/ai04-broker-effect-receipt-snapshot.test.ts:88` failed `counts.trap===0` at hostile Proxy reserve and commit. Native Node22 isolation: `util.types.isProxy(proxy)` triggers zero traps; `(async()=>proxy)()` triggers exactly `get('then')` before application inspection. The new source path uses a strict opaque frozen null-prototype `{receipt:Proxy}` carrier, preserving original signed receipt bytes, with all 12 original zero-counter negative assertions unmodified and one positive Ed25519 envelope test. **New CI exact SHA and final results must be checked; no previous PASS can transfer.**
