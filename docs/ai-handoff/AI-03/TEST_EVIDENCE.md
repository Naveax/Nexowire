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
