# AI-03 | Test evidence

## Initial verified references
- Main on 2026-10-31: `a19a228dc6f19fd484cf935e941a00ea625233f8`.
- #970 HEAD `5e09c01a1f43b25eaa6b2833dfa191bfdea56b4c`; #981 base `7e4093c30c1ead3cd22888184450c34aef4737da`. GitHub compare status `ahead`, 31 ahead, 0 behind, merge base equal to #970 HEAD.
- #981 HEAD `b4d6e57053cce6738087e8cecf932fab3492f3c3`; #982 base equals this exact SHA.
- #982 HEAD `5e52b756cc6959ffacb7bcd25f2fc1ad2beccc39`, pre-AI03 CI `41139860087`, status completed SUCCESS. **This is parent-only evidence.**
- AI-03 source change HEAD before handoff docs: `f92e7e1edc89dfa0c38e5e01040cfcf1b9b05ead`. The final Draft PR HEAD has to be verified independently.

## New negative coverage (source authored; not yet a PASS)
- [PENDING NEW-HEAD CI] TLS client rejects 200 responses lacking or duplicating `Content-Type`, with `text/html`, and with nonidentity/ambiguous encoding.
- [PENDING NEW-HEAD CI] TLS server rejects a disposable zero-day/expired client certificate **before** handler dispatch.
- [PENDING NEW-HEAD CI] Server SPKI rotation rejects an old pin before verifier authentication/ledger read and requires a new explicitly configured pin. Local fixtures are signed by a disposable test CA, not real enrollment.
- Existing suite retains invalid signer, wrong owner/session, nonce/hash replay, lost ACK, slow/partial response, body bound, bad role, revoke-after-sign and durable DB one-use cases.

## Local runner availability
- Local sandbox: Linux, Node `v22.16.0`, OpenSSL `3.5.5`; `git ls-remote` could not resolve github.com. No real repository clone/worktree or installed `node_modules` present. GitHub connector branch isolation is used instead. **No repository test command was executed locally.**
- `node --test --import tsx test/core-native-verifier-server.test.ts`: NOT RUN, exit N/A.
- `node --test --import tsx test/core-native-enrollment-verifier-handler.test.ts`: NOT RUN, exit N/A.
- `node --test --import tsx test/postgres-core-approval-ledger.test.ts`: NOT RUN, exit N/A (requires disposable PostgreSQL and explicit opt-in).
- `node --test --import tsx test/core-native-consent-transport.test.ts`: NOT RUN, exit N/A.
- `npm run typecheck`: NOT RUN, exit N/A.
- CI: New PR-run status/run ID and exact workflow SHA must be inspected after PR creation. Never claim skipped integration/physical cases as PASS.

An isolated OpenSSL probe confirmed zero-day disposable cert generation and expiration behavior. That is **not** a Nexowire integration test.
