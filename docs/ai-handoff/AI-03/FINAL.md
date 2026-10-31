# AI-03 | FINAL (source handoff, exact-head CI in progress)

- Verdict: `READY_FOR_REVIEW` for source pending this commit's exact CI; **NO_GO** for production CORE.
- Draft PR [#988](https://github.com/Naveax/Nexowire/pull/988), branch `ai/03-native-verifier-20261031`, base `5e52b756cc6959ffacb7bcd25f2fc1ad2beccc39`.
- Prior candidate `a1cea7e58a853d9e598477e0f2efd64a65c361f5` CI run [41197111450](https://github.com/Naveax/Nexowire/actions/runs/41197111450): 6/7 SUCCESS while browser-live still running; Node 22/24 each 2399 PASS, 0 FAIL, 352 SKIP, 2 TODO. **Not proof for the follow-up HEAD.**
- New work: `src/protocol/core-native-consent-transport.ts` now requires explicit protected `fetchImpl`; no global fetch fallback; rejects ambiguous signed JSON HTTP metadata. `test/core-native-consent-transport.test.ts` adds associated denial/positive cases.
- Existing AI-03 work: `src/security/core-native-mtls-fetch.ts` strict pinned TLS1.3 client and metadata, `test/core-native-verifier-server.test.ts`, `test/core-native-enrollment-verifier-handler.test.ts` expired cert, CA-valid alternate client credential binding, explicit SPKI rotation, replay, owner/session/nonce bounds, timeout/size and bad response negatives.
- Changed paths limited to allowed AI-03 files. All changes remain on the same Draft PR; no merge/deploy/live device/production keys.
- New exact commit SHA and its new exact-SHA CI are to be read from GitHub PR once published. Local repository tests NOT RUN, exit N/A (no clone/dependencies); no physical acceptance claimed.
- Blockers: coordinator production protected transport composition, AI-02 signed v2 grant issuer provenance and restore witness, protected cert/bearer resolver, real Windows kernel readback, independent AI-08 review, physical two-device session/revoke/reboot acceptance. `CONTRACT.md` / `INTEGRATION_REQUEST.md` specify external interfaces; CORE remains disabled.
