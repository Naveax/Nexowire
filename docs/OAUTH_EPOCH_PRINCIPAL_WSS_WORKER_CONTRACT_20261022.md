# #07 → #13/#780: epoch-bound owner principal, not a WSS/worker grant

**Parent:** DRAFT #760 exact `1e41df6cfc60a57e6d0b50344731136705f37030`, Actions `39802818096` 7/7 SUCCESS. WSS #720 exact `f79b3cce45b9334598ea7acb39873d1231dc1594`, Actions `39659414593` 6/7 (Windows `browser-live` FAILED). The parent source has **not** been installed as the production Cloudflare issuer.

## Concrete smallest #07 interface gap

In #760, the configured `epochAccessVerifier.authenticateAccessToken()` returns a verified `sessionEpoch` from a current joined owner/session read, but `McpOAuthService.authenticateAccessToken()` intentionally returns only legacy `{accountId,clientId,resource,scopes}`, discarding the epoch. A WSS/coding-worker owner callback would otherwise be tempted to infer the epoch or trust stale token claims. Neither is acceptable.

This child adds an OAuth-owned **`McpOAuthService.authenticateOwnerForExternalWriter({accessToken,expectedClientId,expectedResource})`** returning an immutable **authentication-only** principal with `{accountId,clientId,issuer,resource,scopes,oauthSessionEpoch,authority:'owner-authentication-only'}`.

- Only callable successfully in explicitly opted-in strict `epoch-atomic` mode with the joined `epochAccessVerifier`; legacy setup throws `OAUTH_EPOCH_BOUND_AUTHORITY_REQUIRED`.
- `expectedClientId` and `expectedResource` MUST come from independently pinned trusted server configuration, **not** the Bearer, request body, WSS frame or checkpoint. Exact resource/client comparison and MCP scope and epoch sanity are enforced. Verifier failure or missing/locked/revoked access denies without fallback.
- Shares one internal validation path with `authenticateAccessToken`; no duplicate or differently trusting access verifier.
- Returned object deliberately has **no token**, refresh credential, cookie, GitHub state, WSS operator key, owner WSS sessionGeneration, deviceId, taskId, worktreeId, privilege, Windows token or replay-capable grant. It must **never** be used as a cached grant or sufficient authorization for tool execution.
- The returned `oauthSessionEpoch` is the **OAuth account session generation**, **not** GitHub login HMAC signing-key epoch, WSS device/owner generation, device pairing revision or a high-integrity Broker grant. All epochs remain independent.

## WSS #13 production writer callback needed (NOT implemented here)

The production operator must own an authenticated, fresh issuer callback, independently provisioned on the same external owner authority that enforces OAuth logout/atomic refresh/access readback. After owner-only authentication, #13 must independently read WSS owner account, current device signing key / revision, WSS `sessionGeneration`, server-scoped task/worktree grant, and **linearize dispatch/commit against revoke-start** with a rollback-independent authority. An OAuth identity accepted at time `t` does not authorize WSS issuance at `t+Δ` without a final atomic decision. A stale signed receipt, UNKNOWN lost ACK or provider outage must never trigger a blind retry.

Proposed separation:

```ts
// OAuth #07, trusted operator only (snapshot, NOT a grant):
oauth.authenticateOwnerForExternalWriter({
  accessToken, expectedClientId: PINNED_CLIENT_ID,
  expectedResource: PINNED_MCP_RESOURCE,
});
// WSS #13, separately owned (NOT in this PR):
// authorizeEnrollmentOrMutation({ownerPrincipal, deviceRef, taskRef,
//   worktreeRef, deviceEpoch, wssGeneration, pairingRevision, requestId})
//   -> DENIED | UNKNOWN | externally atomically committed scoped receipt
```

## Negative regression evidence

The existing staged SQLite test now verifies that after Owner A's trusted logout, an attacker restoring the old access expiry does **not** produce an owner principal even though the legacy OAuth verifier would accept the row. It retains **8 concurrent rejected revoked Owner A refresh attempts** and independent Owner B refresh/access admission. A separate small negative checks missing strict verifier, wrong server-pinned client/resource, provider outage, authentication-only marker, frozen output and absence of replayable tokens or device/worktree/Windows authority. Already-green issuer HMAC rotation, abandoned tab and WSS #720 re-pairing suites remain untouched.

## Exact NO-GO

This is source-only; **no live Cloudflare/D1/token, actual WSS writer callback, owner operator keystore, sandbox, native Broker, UAC or VM integration**. Owner logout and key epoch rollback cannot be proven by source fixtures. #780 checkpoint must persist only non-secret references and expected epochs/hashes, **never Bearer, refresh, login cookie, signed OAuth state or replayable grant**. A durable WSS/coding-worker effect still needs separate owner/device/worktree authorization and external commit-vs-revoke CAS. No inference of Windows HIGH or CORE is permitted.

Keep this child DRAFT, depend on #760, and require own exact-head CI plus independently provisioned/physically tested external acceptance before any deployment.
