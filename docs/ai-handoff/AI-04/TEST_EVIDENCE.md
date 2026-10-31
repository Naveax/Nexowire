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
