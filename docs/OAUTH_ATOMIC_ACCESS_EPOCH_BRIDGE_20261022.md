# OAuth #07: strict refresh and strict access verifier must share the same owner epoch

**Source-only DRAFT child of #748 exact `9ffe6accaa45235c45b7b0faa2080391a76f6cc0`.** Parent #748 GitHub Actions `39735987704` 7/7 SUCCESS, and #721 `39676732876` 7/7 SUCCESS.

## Smallest missing issuer boundary

The #748 strict `McpOAuthService.token()` uses injected atomic, epoch-aware refresh, but `McpOAuthService.authenticateAccessToken()` still previously queried the legacy store directly, allowing an artificially re-expired stale token after owner logout to be returned as a valid identity. Simply having correct epoch-aware refresh is not proof that every access is bound to the current owner login generation.

This child makes `epochAccessVerifier.authenticateAccessToken()` mandatory when `refreshMode: 'epoch-atomic'` is selected. A strict issuer cannot start without **both** the atomic refresh authority and the independently authoritative owner-epoch access verifier. Legacy defaults and Cloudflare runtime wiring are unchanged.

In strict mode, access verification never reads the legacy store. The injected verifier must atomically read/join the access record and current unlocked account epoch; strict issuer additionally checks returned owner account, nonempty client, exact first-party OAuth resource, acceptable MCP scope and nonnegative integer session epoch. A wrong resource/client, invalid scope/epoch, revoked owner, missing verifier or verifier outage cannot fall back to legacy access-token acceptance. Source-level verifier failures propagate as infrastructure errors, not acceptance.

## Reused adversarial evidence

The **existing** `test/oauth-first-party-logout-epoch-refresh-integration.test.ts` now injects the already green `ProposedMcpOAuthEpochAccessVerifier` alongside `ProposedMcpOAuthEpochAtomicRefresh`. It retains 8/8 denied revoked owner A refresh attempts and owner B successful rotation, then explicitly simulates a hostile stale writer re-extending owner A's access expiry: legacy store accepts it, strict current-epoch verifier denies it, while owner B's epoch-current access succeeds. A small additional test isolates malformed first-party client/resource/scope/epoch verifier records and provider outage, proving no legacy fallback. All prior #675/#697/#721 issuer signing-key rotation, abandoned browser, owner CSRF and Windows CORE boundary negatives remain unchanged.

## Hard NO-GO / limitations

- **No actual Cloudflare Worker, OAuth issuer key, D1 migration, production token, Agent, UAC or VM has been modified.** Live strict issuer wiring is disabled until independently approved.
- The verifier adapter remains a staging-only proposed class and **external authoritative D1 multi-Worker access proof is not yet established**. Even with this strict access bridge, authorization-code issuance is still legacy and needs separately reviewed epoch atomicity before production deployment. Neither this PR nor prior PRs deliver full logout acceptance.
- Every OAuth identity is web authorization only, **never Windows elevated HIGH/CORE privilege**. Local signed Broker/owner approval is a different independent authority.
- Child must remain DRAFT, based on #748 rather than main, and must pass **its own exact-head CI** before reviewer acceptance. Do not merge/deploy independently.

**No duplicated green source QA and no production claims.**
