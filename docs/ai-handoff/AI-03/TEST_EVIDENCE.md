# AI-03 | TEST_EVIDENCE

## Latest completely verified source SHA / CI
- **Source SHA:** `7ee900583eaf103603ea8534460a6708cd6b0465`, branch `ai/03-native-verifier-20261031`, [Draft PR #988](https://github.com/Naveax/Nexowire/pull/988). **Base SHA:** `5e52b756cc6959ffacb7bcd25f2fc1ad2beccc39` (#982; upstream #981/#970).
- **Matching workflow:** `369213208`, [GitHub Actions run #41243629237](https://github.com/Naveax/Nexowire/actions/runs/41243629237), **completed SUCCESS 7/7**.
- `test (22)` job `124662450773`: SUCCESS, `npm run typecheck` SUCCESS, Node test suite **2,760 total, 2,403 PASS, 0 FAIL, 355 SKIP, 2 TODO**, build SUCCESS.
- `test (24)` job `124662450852`: SUCCESS, `npm run typecheck` SUCCESS, Node test suite **2,760 total, 2,403 PASS, 0 FAIL, 355 SKIP, 2 TODO**, build SUCCESS.
- `linux-native-live` job `124662450723`: SUCCESS; real isolated PostgreSQL enrollment **10/10 PASS**.
- `browser-live` job `124662450850`: SUCCESS; `wsl2-live` `124662450818`: SUCCESS; `macos-agent-lifecycle-live` `124662450633`: SUCCESS; `security-operational-live` `124662450789`: SUCCESS.
- The 355 SKIP and 2 TODO in the general Node test suites are disclosed, **not counted as PASS**; the PostgreSQL integration tests are intentionally SKIP in generic Node jobs and independently run against disposable PostgreSQL in `linux-native-live`.

## Protected issuer / SQL one-use handoff negatives
- Real ephemeral PostgreSQL test cases were all PASS:
  1. `approval readback cannot replace the separate one-use D1 handoff`;
  2. `requested issuer must match independent protected readback`;
  3. `issuer changes during native witness await deny before INSERT`;
  4. `issuer changes after COMMIT deny ACK but preserve tombstone`;
  5. `independent verifiers racing the same receipt admit exactly one`;
  6. `lost handoff COMMIT ACK never becomes a successful retry`;
  7. `forged receipt fields and current native session changes deny handoff`;
  8. `database-clock expiry and final-witness revoke reject without reopening history`;
  9. `revoke after handoff COMMIT suppresses readback and preserves the tombstone`;
  10. `a controlled late ACK denies success without undoing consumption`.
- The independent `issuerSpkiSha256` is read from a **synthetic protected-native callback** in these tests, never treated as actual protected Windows local v2 grant provenance. Changed issuer before SQL INSERT must leave zero handoff rows; changed issuer after COMMIT must deny ACK/readback without permitting a second consume.

## TLS / protocol source tests
- Real disposable TLS1.3 loopback socket tests: absent/expired client certificate; alternate valid same-CA client with stolen bearer denied; expired server cert even with matching pinned SPKI; server key rotation invalidates stale SPKI pin; owner/session scope, nonce/replay/revoke, no redirect/retry, incomplete and oversized responses.
- Shared authority transport: explicit protected `fetchImpl` mandatory, **never ambient global fetch**; only signed HTTP 200 JSON identity metadata accepted; 201/202/206 reject, ambiguous media/encoding reject; deadline bounds uncooperative fetch, body read and stalled stream cancellation.
- The above are source and disposable infrastructure tests. They are **not** production PKI, CNG/TPM, physical UAC/owner consent, trusted Windows SID/session/LUID kernel readback, verified revoke witness or physical two-device acceptance.

## Local commands (NOT RUN, exit N/A)
- `node --test --import tsx test/core-native-verifier-server.test.ts`: local N/A (the test was exercised via exact-SHA CI as part of the Node suite).
- `node --test --import tsx test/core-native-enrollment-verifier-handler.test.ts`: local N/A (Node CI).
- `node --test --import tsx test/postgres-core-approval-ledger.test.ts`: local N/A (real disposable PG integration in Linux native CI).
- `node --test --import tsx test/core-native-consent-transport.test.ts`: local N/A (Node CI).
- `npm run typecheck`: local N/A (Node22/24 CI step SUCCESS).
- No local repository checkout/dependencies were present. Do not claim local test exit 0.

## Historical red evidence and SHA separation
- `cced7f230cdb286e7a51b75b0cf50686c88eb59c` / run [41211788242](https://github.com/Naveax/Nexowire/actions/runs/41211788242): **RED** at typecheck (`TS18047`, `TS18048`, `TS2345`) for native issuer/null/untyped SQL scope. Not a test PASS.
- `751968b9a0c0d153b49a3db2bc3bc1271a05c782` / run [41212016815](https://github.com/Naveax/Nexowire/actions/runs/41212016815): **RED** at typecheck (`TS2345`). Fixed by explicit terminal `CoreApprovalLedgerError` throw without weakening issuer checks.
- `bfb0a4e6eff171f08b8d39d2f003f9fd3cde02e6` / run [41212180510](https://github.com/Naveax/Nexowire/actions/runs/41212180510): **SUCCESS 7/7**, with eight disposable PostgreSQL enrollment negatives. Latest source HEAD added two more race tests and passed them.
- **This document update is docs-only and creates a NEW SHA**. The preceding `7ee900583eaf103603ea8534460a6708cd6b0465` CI is exact only for its commit, not proof of an untested child. Check the new head CI separately.

## Additional AI-03 issuer clock/INSERT race regression (current-head CI PENDING)
- A newly added real disposable PostgreSQL negative case `real PostgreSQL enrollment: issuer rotation after DB clock read denies handoff before INSERT` simulates a protected issuer change after the **real SQL clock query returns** but before durable enrollment consumption. Expected: fail-closed `CORE_APPROVAL_ISSUER_UNVERIFIED`, **zero enrollment_consumptions rows**, and no replay tombstone. The regression would fail against the preceding source order, which checked the issuer before the awaited SQL read.
- The second trusted native/provenance recheck has been relocated **after** the locked binding and database-time read, immediately before INSERT. No tests are skipped/loosened; the ten previous enrollment negatives remain unchanged. PostgreSQL environment must be explicitly enabled; this new test is **NOT YET VERIFIED** until matching exact-HEAD Linux-native CI reports PASS.
- Latest *previous* exact HEAD `21ebd6953d68850ba16e3a624575024002c3b627` had [CI #41246429714](https://github.com/Naveax/Nexowire/actions/runs/41246429714) **7/7 SUCCESS**; this evidence does **not** apply to this new source/test child SHA. Physical Windows issuer/mTLS identity remains untested, CORE production NO_GO.

## 2026-11-01 candidate: actual TLS hostname and signed scope substitution

- Baseline `5915eb1980ca92430401e79d0bed410a94d0cfce` CI [#41249314952](https://github.com/Naveax/Nexowire/actions/runs/41249314952) observed 6/7 jobs SUCCESS, `browser-live` in_progress; **no full-success claim**. This change creates a new SHA requiring its *own* exact CI.
- Fixture: disposable CA issues another TLS1.3 server cert with SAN `DNS:untrusted.invalid`; tested origin is `https://127.0.0.1:<port>`. It uses its **matching real SHA-256 SPKI pin** and valid CA. The client must reject due to wrong hostname, with **zero authenticate/consume/readback calls**. No production certificates.
- Additional negative matrix against real local loopback handler: `verify-and-consume` wrong `ownerEpoch`, `revokeEpoch`, `grantGeneration`, installation, enrollment and approval timestamp fail 403 before ledger consume; `current-readback` wrong Windows SID/session/LUID/session epoch and grant/revoke/owner epochs never returns HTTP 200. Existing nonce/hash/signature/replay/redirect/Content-Type/abort tests preserved without skips.
- Commands expected in exact CI: `npm run typecheck`, `node --test --import tsx test/core-native-enrollment-verifier-handler.test.ts`, `npm test`, `npm run build`. **Local not executed**, no checkout; evidence will be updated only after CI exit status. Real owner/TPM/cert-custody/Windows acceptance **NOT_TESTED**.
