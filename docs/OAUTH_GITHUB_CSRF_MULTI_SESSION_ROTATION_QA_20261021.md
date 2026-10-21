# #07 GitHub OAuth state hostile QA: two Workers / key rotation / aborted tabs

**Exact parent tested:** PR #675 `257d89e168c53cbe4aafafb74e4b236ed7f9dfa5` (its own CI run `39632701546` 7/7 SUCCESS). This child only adds independent tests and this report. Parent #675 remains DRAFT, never deployed.

## Synthetic acceptance

- **Concurrent two-Worker callbacks:** deterministic 20-party entry barrier, two independently opened file-backed SQLite handles, one shared CAS row, only **one** callback may exchange an OAuth code and produce a signed owner session; wrong browser cookie, swapped state or missing cookie fail without any upstream exchange. Another browser's independent state remains valid and is linked to a different GitHub account.
- **Signing-key rotation:** old signed state is rejected with the new secret; new signed state succeeds. Existing code does not independently persist a signing-key epoch: rolling back to the old key could make a still-`pending`, unexpired old state admissible. The test explicitly revokes the old pending row using the shared CAS before a simulated key rollback; it **does not** assert automatic rotation revocation.
- **Abandoned tab:** no callback without the bound cookie; explicit terminal CAS revoke blocks restoration, and state is invalid at the exact 10-minute deadline. A browser tab close is *not observed by the server*, so it cannot automatically revoke pending state. Time-based expiry works even when an old row remains pending until audited cleanup.
- **Refresh after revoke:** `invalidateAccessToken` only revokes one access token; the same owner's refresh token can still rotate (documented present behavior, **not a fix**). Explicit refresh-token revocation denies new exchange, and does not affect a foreign owner. Reviewed staging session-epoch/logout tests remain synthetic and are not deployed.
- **Cross-owner CSRF:** exchanging browser A's signed state using browser B's cookie, or browser B's state using A's cookie, is denied *before* the GitHub token request. A valid GitHub login establishes a web-session role only; it never proves a signed Windows HIGH token, CORE/ROOT activation or privileged Broker enrollment.

## Trust limits / production blockers

These checks use a local SQLite simulator with two handles and an offline synthetic GitHub fetch implementation. This **is not Cloudflare D1 multi-region external linearizability proof**, DCR/PKCE issuer acceptance, native ChatGPT/Codex callback, or physical Windows authorization. No live Agent/Broker/UAC, VM, DNS, Cloudflare, real user session or token was touched.

PR #675 still lacks reviewed Cloudflare Worker binding to its durable state store, live D1 schema migration, staged key-rotation window and bulk revoke policy, actual logout-to-pending-state cancellation, and physical browser-tab session continuity. Any production deploy before these are resolved may fail closed and break GitHub login. Tests intentionally avoid modifying the #03/#04 implementation owners.

**No production merge/deploy recommendation.** Review this QA child only as source test evidence; keep both PRs DRAFT.
