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

## Follow-up ledger issuer-provenance regression (new commit needs exact CI)
- Source: `src/security/postgres-core-approval-ledger.ts`; test: `test/postgres-core-approval-ledger.test.ts`.
- New real disposable PostgreSQL negative verifies incorrect request `issuerSpkiSha256` is denied *before handoff consume*, an absent independent native issuer is denied, correct protected issuer allows exactly one consume, and a subsequently changed issuer denies current readback without reopening the durable one-use tombstone. Existing seven PostgreSQL enrollment tests remain enabled and not weakened; their native issuer fixture is now explicit.
- The protected issuer record is STILL an isolated fixture, NOT a real CNG/TPM signed grant or Windows owner acceptance. Source SHA `aaf1cf93f3aca46da313ba513a9b0a524be043f0` has docs-only CI run #41211357704; no prior SHA outcome is acceptance for this new code. Read final exact SHA and CI after publication.

## Historical red CI for first issuer-provenance implementation
- Initial AI-03 issuer-bound candidate exact SHA `cced7f230cdb286e7a51b75b0cf50686c88eb59c`, workflow 369213208 run [41211788242](https://github.com/Naveax/Nexowire/actions/runs/41211788242), failed at `npm run typecheck` before Node tests due `src/security/postgres-core-approval-ledger.ts` TypeScript narrowing errors: `TS18047` (possibly-null native witness, line 101), `TS18048` (possibly-undefined DB row, line 321), `TS2345` (unknown issuer value where string expected). This source SHA is **RED**, never retroactively marked PASS.
- Follow-up code change narrows `n` explicitly and checks the SQL issuer as a separately guarded string before comparison. Ledger issuer matching remains mandatory; no negative tests skipped or relaxed. Its new exact SHA and CI must be confirmed independently after publication.

- Follow-up exact SHA `751968b9a0c0d153b49a3db2bc3bc1271a05c782` run [41212016815](https://github.com/Naveax/Nexowire/actions/runs/41212016815) also failed before tests with `TS2345` at ledger lines 319/325 because TypeScript did not narrow an unknown SQL column through the project's `fail()` helper. The next source revision uses an explicit `throw new CoreApprovalLedgerError('CORE_APPROVAL_ENROLLMENT_NOT_CONSUMED')` for invalid SQL issuer type/format; the value becomes statically narrowed to `string` before the protected comparison. This preserves the identical terminal fail-closed code and does not skip tests. An isolated local TypeScript 5.8.3 strict narrowing snippet with the explicit `throw` returned exit 0; this is **not** the repository typecheck. New exact-HEAD CI required.

## Async issuer race tests: new exact-HEAD CI required
- Two new **real disposable PostgreSQL** integration tests in `test/postgres-core-approval-ledger.test.ts` (enabled only with `NEXOWIRE_PG_DISPATCH_INTEGRATION=1`): (1) issuer A at initial native readback but issuer B at the second protected readback inside the SQL transaction must reject before INSERT and retain zero enrollment rows; (2) issuer changes only *after* a real committed handoff, so post-COMMIT acknowledgment and current readback fail closed while the one-use tombstone persists and both issuer A/B retries remain replays.
- The existing eight enrollment integration tests stay enabled and unchanged. A matching issuer readback remains a disposable fixture, **not** protected production v2 CNG/TPM provenance or physical consent. Previous source exact HEAD `bfb0a4e6eff171f08b8d39d2f003f9fd3cde02e6` had GitHub CI #41212180510 **7/7 SUCCESS**, Node 22/24 each 2,403 PASS, 0 FAIL, 353 SKIP, 2 TODO, PostgreSQL eight enrollment integration PASS. The present follow-up's exact CI is independent and must be verified after publication.
