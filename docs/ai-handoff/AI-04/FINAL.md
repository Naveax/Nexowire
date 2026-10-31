# AI-04 FINAL | source review candidate

**Decision:** READY_FOR_REVIEW for source-only safety; **NO_GO** for production CORE, physical enrollment or deployment.

- **Draft PR:** https://github.com/Naveax/Nexowire/pull/987
- **Branch:** `ai/04-broker-admission-20261031`
- **Base:** `7e4093c30c1ead3cd22888184450c34aef4737da` (#980 integration Draft)
- **Verified source candidate:** `b4b1cbf57d40b2f16926f132b435837a527d5e07`
- **Source CI:** `CI 41200010652` (https://github.com/Naveax/Nexowire/actions/runs/41200010652). Verified source run completed SUCCESS 7/7, including Windows native Job compile and regressions. This documentation-only commit must get its own exact-head CI; old source SHA CI cannot be transferred.
- **Changed sources:** `src/agent/privileged-broker-effect-admission.ts`, `src/agent/broker-external-dispatch-fence.ts`, `src/agent/broker-dispatch-authority-handler.ts`, `native/windows-job-owner.c`.
- **Changed tests:** four new `test/ai04-broker-*.test.ts`; `test/broker-dispatch-authority-handler.test.ts` one negative.
- **Changed handoff:** `docs/ai-handoff/AI-04/{STATUS,CONTRACT,TEST_EVIDENCE,INTEGRATION_REQUEST,FINAL}.md`.
- **Proof summary:** 26 new/incremental disposable source tests PASS in Node 22/24 CI; exact Node 22 aggregate: 2765 tests, 2411 PASS, 0 FAIL, 352 SKIP, 2 TODO; `npm run typecheck`, `npm test`, `npm run build` exit 0; Windows native Job guardian MSVC compilation and Job regression steps SUCCESS.
- **Safety work:** Broker OS owner binding and protected HIGH witness detached immutable snapshots; signed receipt exact JSON UTF-8 source/canonical guard; strict owner/capability/ticket/nonce/epoch pre-effect checks; explicit Win32 child inherited IO allowlist.
- **Physical blockers:** equal-HIGH+SeDebug and UAC-linked Medium adversarial negatives BLOCKED, pre-seal Job handle theft window OPEN, no protected installed Broker/external durable CAS/authorized owner physical proof. Synthetic CI or Job membership cannot close these.
- **Other-agent handoff:** `INTEGRATION_REQUEST.md`; AI-05 per-effect external CAS/executor, AI-07 isolated worker + OS protection, AI-08 independent QA, coordinator trust publisher/workflow.
- **Explicitly NOT DONE:** merge, rebase, force push, tag/release/deploy, CORE enable, service/ACL/UAC/DPAPI alteration, real Windows user devices or physical enrollment.

The 14 November 2026 target does not override missing kernel or owner evidence.

## 2026-11-01 review candidate update

- Historical `b4b1cb...` source evidence above is not the latest HEAD.
- Source SHA `d971f0239d3d2b76b406697aac0183cbdea60097` adds immutable signed receipt envelope negative tests (11 cases) and had Node22/24 SUCCESS; [run 41246475485](https://github.com/Naveax/Nexowire/actions/runs/41246475485) Windows job still in progress when this handoff was prepared. Six completed jobs SUCCESS at that observation.
- Source SHA `0ce89fce32252ba84478472f3fc9d479156ee18c` pins top-level Broker identity/CAS dependencies and adds four negative constructor tests. After this document commit, check the **live PR exact HEAD and its own CI**; prior results cannot be inherited.
- All changes remain AI-04 owned. No merge, rebase, deploy, Windows service, UAC/ACL, real device or CORE flag mutation.
- Remaining physical P0: equal-HIGH SeDebug, UAC-linked Medium, pre-seal Job handle duplication, native protected Broker/OS owner identity, independently operated persistent one-use CAS, isolated worker/revoke drain and two authorized-device acceptance.
- **Decision: source-only REVIEW pending latest exact-HEAD CI; production CORE NO_GO.**

## 2026-11-01 P0 Promise-assimilation fix candidate
- Owned source/test changes: `privileged-broker-effect-admission.ts`, `ai04-broker-effect-receipt-snapshot.test.ts`; no native Windows Job rewrite, C4133 or handle inheritance check weakened.
- Source contract accepts a verified null-prototype data carrier with nested untrusted Proxy. Signed UTF-8 payload remains exact original receipt fields. Ed25519 positive envelope test added, existing reserve/commit negative zero-trap/effect/getter assertions unchanged.
- Prior SHA `8ae78075f2f1c6fbb1f314aa6c38ae6daf36d24a` Node22 2 FAIL due to runtime `get('then')` on raw async-returned Proxy. New HEAD CI pending. Legacy raw async Proxy cannot guarantee zero then traps, so production protected adapters require carrier/primitive wire responses. Physical OS/Broker/CAS acceptance BLOCKED, CORE NO-GO, Draft only.
