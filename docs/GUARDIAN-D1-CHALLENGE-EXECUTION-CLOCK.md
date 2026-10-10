# Guardian D1 enrollment: check time at the database write, not only the caller

The source-only Guardian key enrollment challenge adapter (`verifyAndConsumeGuardianEnrollmentChallenge`) already verifies an Ed25519 proof-of-possession, exact owner/request/pairing and a one-use D1 conditional UPDATE. However, its original expiry predicate compared the challenge against an application timestamp captured **before** awaiting the D1 UPDATE. The D1 operation can be queued past expiration while still receiving that earlier, valid timestamp.

The conditional UPDATE now requires **both** the signed application timestamp bounds and the SQLite **execution-time UTC timestamp** obtained from `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` on the same statement. SQLite's UTC output format matches canonical signed ISO-8601 timestamps (`...ss.sssZ`). The existing atomic `consumed_at IS NULL`, bound nonce digest, current matching paired win32 FULL/Broker-ready device and exact owner binding checks remain unchanged.

The new test executes the *actual SQL* in an isolated `node:sqlite` database with the two necessary fixture tables, rather than merely looking for a substring in a mocked D1 query. It confirms current signed proof is consumed exactly once, while a previously valid signed challenge whose D1 processing occurs **after** expiration is rejected with `consumed_at` still NULL.

**Still blocked:** this adapter only consumes a one-use challenge; it does NOT enroll an Ed25519 signing key, create keypairs, trust an unprotected private key or grant a Windows OS command. Cloudflare migrations 0017/0018 are NOT applied to production, no Worker endpoint is wired, and owner-approved independently protected Guardian installation plus P0 #271 remediation remain mandatory before privileged ON/OFF.

No live D1 queries, Windows tasks/ACLs, Worker release, Agent installation or secret writes occur in this PR.
