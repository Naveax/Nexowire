# AI-03 | TEST_EVIDENCE

## Exact source, PR and CI identity
- Branch `ai/03-native-verifier-20261031`, [Draft PR #988](https://github.com/Naveax/Nexowire/pull/988), exact base `5e52b756cc6959ffacb7bcd25f2fc1ad2beccc39` (#982). #982 base is #981 head `b4d6e57053cce6738087e8cecf932fab3492f3c3`; #970 is upstream of #981.
- **Last tested source SHA:** `5959e6cbb7b44f30d489b492c50201a765a0a0cb`. Exact GitHub `CI` workflow **369213208**, run [#41200342022](https://github.com/Naveax/Nexowire/actions/runs/41200342022), **completed SUCCESS 7/7**.
- Job IDs and outcomes:
  - Node 22: `124534810760`, SUCCESS; typecheck, tests, build. **2,757 tests; 2,403 PASS; 0 FAIL; 352 SKIP; 2 TODO**.
  - Node 24: `124534810700`, SUCCESS; typecheck, tests, build. **2,757 tests; 2,403 PASS; 0 FAIL; 352 SKIP; 2 TODO**.
  - Linux native: `124534810641`, SUCCESS; seven real disposable PostgreSQL enrollment tests passed.
  - Windows browser-live `124534810514`, WSL2 `124534810681`, security-operational `124534810763`, macOS lifecycle `124534810663`: all SUCCESS.
- Previous source sha `85df4259de234ddcebd8e73277df979d878db921` CI #41198185416: SUCCESS 7/7 with 2,401 PASS on each Node version. **Do not substitute prior SHA evidence for current SHA.**
- This handoff evidence update itself is docs-only and has a *new* exact HEAD on publication; check its own workflow. Do not claim CI from the preceding source HEAD covers a different git commit.

## Focused negative/positive proof
- `signed non-200 success responses are terminal and never accepted as verifier ACK`: Node 22/24 PASS; HTTP 201/202/206 signed responses rejected, signed HTTP 200 accepted.
- `native authority deadline is absolute when injected transport, body or cancel ignores abort`: Node 22/24 PASS; noncooperative fetch/body timeout and stalled cancellation fail closed without retry.
- `omitted protected transport refuses global fetch fallback before exposing bearer`: Node 22/24 PASS; missing mTLS-capable injection cannot silently fall back to global fetch.
- Real disposable TLS1.3 loopback tests: expired client/server cert, missing client cert, same-CA alternate client with reused bearer, explicit server SPKI rotation/pin mismatch, timeout, redirect, response size/metadata, owner/session/nonce/replay and revoke. These are **real socket tests using disposable certs**, not production PKI or owner approval.
- Seven disposable PostgreSQL tests cover independent one-use handoff, two-verifier race, lost COMMIT ACK, forgery/session changes, expiry/revoke, post-commit revoke and late-ACK suppression. Their native witness/signatures are still isolated fixtures; database tests do not imply physical enrollment.

## Commands and evidence boundaries
- `node --test --import tsx test/core-native-verifier-server.test.ts`: NOT RUN locally; exit N/A.
- `node --test --import tsx test/core-native-enrollment-verifier-handler.test.ts`: NOT RUN locally; exit N/A.
- `node --test --import tsx test/postgres-core-approval-ledger.test.ts`: NOT RUN locally; exit N/A. Real disposable PG cases were run in the Linux native CI job above.
- `node --test --import tsx test/core-native-consent-transport.test.ts`: NOT RUN locally; exit N/A.
- `npm run typecheck`: NOT RUN locally; exit N/A. CI Node22/24 typecheck/build steps returned SUCCESS.
- Isolated disposable keys/CA/DB are not Windows CNG/TPM/DPAPI custody, live SID/session/LUID kernel readback, independent restore witness, two-device physical acceptance or production signing keys. **CORE production NO_GO.**
