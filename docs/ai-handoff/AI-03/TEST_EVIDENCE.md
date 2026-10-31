# AI-03 | TEST_EVIDENCE

## Identity and dependency chain
- Main observed 2026-10-31: `a19a228dc6f19fd484cf935e941a00ea625233f8`.
- #970 handler HEAD `5e09c01a1f43b25eaa6b2833dfa191bfdea56b4c`, ancestor of #981 base `7e4093c30c1ead3cd22888184450c34aef4737da` (31 ahead, 0 behind). #981 head `b4d6e57053cce6738087e8cecf932fab3492f3c3` equals #982 base. #982 head `5e52b756cc6959ffacb7bcd25f2fc1ad2beccc39` is AI-03 PR base.
- Draft PR: https://github.com/Naveax/Nexowire/pull/988, branch `ai/03-native-verifier-20261031`.
- **Last completely verified source SHA:** `85df4259de234ddcebd8e73277df979d878db921`. GitHub Actions workflow CI 369213208 run [41198185416](https://github.com/Naveax/Nexowire/actions/runs/41198185416) **completed SUCCESS, seven of seven jobs** (Node 22 job `124528660410`, Node 24 `124528660349`, security `124528660429`, WSL2 `124528660468`, macOS `124528660536`, Linux native `124528660586`, Windows browser-live `124528660600`).
- Node 22 and Node 24 each **2,755 total; 2,401 PASS, 0 FAIL, 352 SKIP, 2 TODO**, Node sources typecheck and build PASS. This includes `omitted protected transport refuses global fetch fallback before exposing bearer` and `shared authority transport rejects ambiguous HTTP media metadata even with a valid signature` passing both Node versions.
- Linux-native disposable PostgreSQL ran seven real DB enrollment rejection/readback cases successfully: one-use D1 handoff, concurrent consume, lost COMMIT ACK, forged receipt/native change, expiry/revoke, post-COMMIT revoke, late ACK. The database and witness are test fixtures; source success is not physical approval.

## Socket / negative-case coverage
- Actual disposable loopback TLS1.3/mTLS tests verify CA/client cert absence, expired client, a **different same-CA valid client** denied by protected bearer-to-certificate fixture resolver, expired server cert despite a correctly pinned server SPKI, server key-rotation stale pin denial, role/owner/session scope, nonce/hash/signature, replay and revoke, redirect/no retry, bounded/trickled response and content metadata rejection.
- Valid JSON/UTF-8 and identity encoding positive tests pass; gzip/ambiguous/duplicate headers reject.
- New source follow-up adds **strict HTTP 200** to common authority calls; test expects 201/202/206 signed JSON to fail without retry and true 200 to pass. This **follow-up is not covered** by the preceding successful `85df4259de234ddcebd8e73277df979d878db921` run. Exact new SHA/run must be verified after publication.

## Local testing / evidence boundary
- `node --test --import tsx test/core-native-verifier-server.test.ts`: NOT RUN locally, exit code N/A.
- `node --test --import tsx test/core-native-enrollment-verifier-handler.test.ts`: NOT RUN locally, exit code N/A.
- `node --test --import tsx test/postgres-core-approval-ledger.test.ts`: NOT RUN locally, exit code N/A (disposable PostgreSQL integrated in GitHub Linux CI).
- `node --test --import tsx test/core-native-consent-transport.test.ts`: NOT RUN locally, exit code N/A.
- `npm run typecheck`: NOT RUN locally, exit code N/A.
- Sandbox has no checked-out dependency tree or working GitHub DNS; do not promote GitHub CI into a local execution claim.
- Test certificates, local software signer, mock native witness and disposable DB are **not** real Windows UAC, protected CNG/TPM, owner SID/session/LUID kernel readback, rollback-resistant external witness or physical two-PC consent. CORE remains `NO_GO`.
