# Scale v2 S1 — request-time OAuth + device-owner admission (DEV)

**2026-10-15 | S1 #483 | PROPOSAL ONLY.** This is isolated on branch `test/scale-v2-s1-epoch-tool-admission-20261015`, based on verified `main` `e0bdb80a460eea425aab301ccb45773358c604ca`. No live import by the Worker, OAuth router, MCP dispatcher, Windows Agent or Hub. No Cloudflare migration, feature flag, paid plan or quota change.

## Narrow objective

Existing staged S1 work proves access-token validity for the current account session generation and atomic auth-code/refresh exchanges. **An authenticated token is not sufficient authority to command any selected device.** This slice stages one coherent read of current token + device ownership, online status, access mode and session generation to catch a stale owner or revoked session at **request admission**.

`src/product/mcp-oauth-epoch-tool-admission-proposal.ts`:

1. Derives account and client from the **hashed access token in D1**, not an MCP parameter.
2. Uses a joined device ownership check `devices.owner_account_id=t.account_id` for the selected, exact device ID. Offline/missing/foreign devices are refused.
3. Enforces server-selected operation category: `read` permits `safe` or `full` device mode, `write` requires `full`. A real integration must use a static trusted per-tool classification; never let a request argument downgrade a mutating command to `read`.
4. Checks exact first-party OAuth resource, MCP scope, expiry, issuance, monotonic epoch/locked state, legacy logout gate and session event history **in the same SQL snapshot**. A missing current epoch with historical logout never falls back to legacy epoch zero.
5. Exposes a **two-check DEV dispatch wrapper**: first check, optional testing seam, second check immediately before calling a handler. If logout, owner transfer or access-mode downgrade happens before that second check, the handler is never invoked. D1 errors throw (fail closed).

## Windows SQLite test evidence

`test/mcp-oauth-epoch-tool-admission-staging.test.ts` includes **11 tests** for safe-vs-full mode, cross-account device injection, offline and missing devices, logout/relogin, legacy missing-generation corruption, logout between checks, owner transfer between checks, access-mode downgrade between checks, uninterrupted execution exactly once, invalid resource/scope/expiry/op-kind and DB outage.

There is **NO proof of in-flight revocation**: an external side effect can still start after the last database read and before a later logout/owner transfer. The two reads only narrow the race. They are not a transaction with the device executor. It would be incorrect to market this as a real continuous permission lease or an atomic hardware/OS side-effect gate.

## Production acceptance and design blockers

- Match each real MCP tool to an authoritative immutable server-side `read`/`write` or richer per-capability permission classification. Some apparent reads reveal secrets or have side effects; all such tools require stronger scope and consent semantics.
- Do not treat `online=1` as an absolute liveness guarantee; heartbeats and authenticated device credentials need independent freshness and revocation controls.
- The Worker's final authorization must bind first-party account identity, token-client/resource/scopes and selected device **and** have corresponding authenticated Agent-side owner/command authorization before physical execution. Use an operation-level approval/lease or revocation barrier and prove it with adversarial cross-Worker races, not just two SQL reads.
- Implement safe interruption/compensation for running mutating tools, or state precisely which operations are irrevocable and what can be contained. No promise that already launched commands are canceled.
- Verify independent Worker requests and D1 read/session consistency on a disposable, cost-capped Cloudflare D1 staging database, plus provider outage, stale replicas, CORS/CSRF/session attacks and audit trails.
- Real Cloudflare D1 management is **not connected** to the available tools yet. No production schema or Cloudflare dashboard settings were modified for this proposal.
- Keep all S1 staging fixture and application proposals outside deployed production routes pending independent security review, user-approved canary, budget bounds and rollback.

**GO/NO-GO:** DEV-only request admission is supported by local tests; full production authorization/revocation is **NO-GO**.
