# #07 OAuth owner/session versus Windows CORE/ROOT token: source-only QA

**Base:** `Naveax/Nexowire` main `4c5c810134c020cd04a5ef2be5c1138ea1954ad0` (2026-10-21). Scope: synthetic negative tests in `test/oauth-windows-elevation-boundary-negative.test.ts`. These tests never operate Windows UAC, an installed privileged helper, Cloudflare, DNS, real OAuth credentials, Hub or Agent.

## Privilege separation: verified source facts

1. A signed Control Plane web session or a valid MCP OAuth access token identifies an account/client/resource and scopes; it does **not** contain independent local signed publisher approval, protected Broker image/parent/ACL/token/epoch attestation, local owner physical consent, or an elevated Windows access token.
2. Current `ControlPlaneService.setDeviceRootMode` stores exactly **15 minutes** of owner-requested policy and returns `active:false`; `explainDeviceAuthorization` has `root.policyActive:false` and `sessionBound:false` even when the stored lease is unexpired. A 15-minute preference is not Windows privilege.
3. Current CORE preference can be indefinitely stored and revoked. `setDeviceCorePreference` requires an owner identity and reported FULL/online/Broker readiness, but returns `active:false`; `explainDeviceAuthorization` accurately returns `PAUSED_UNVERIFIED`. Preferences and remote Bearer tokens never prove effective Windows elevation.
4. The **desired** CORE contract is one locally owner-approved, signed/protected privileged Broker installation/enrollment, then verified durable delegation without another UAC prompt **per operation**; ROOT grants comparable delegated scope for at most 15 minutes. This source test does **not** implement that missing bootstrap/delegation. It does not authorize clicking/overriding secure-desktop UAC. P0 #271 ACL, #551 signed installer/rollback, #617 token and physical approval gates remain open.
5. Paired-device credential rotation on an isolated memory store invalidates the old credential, clears ROOT and CORE preferences, and leaves the new device offline; an old consumed pairing token cannot re-enroll it. Old owner/device/cookie snapshots must never be admitted based solely on an OAuth Bearer.

## New independent negatives

| Boundary | Actual synthetic result | Unproven behavior |
|---|---|---|
| Tampered HMAC user→admin session, wrong signing key, expiry | Denied | Real account role revocation with persistent session |
| Valid admin session of a **different** owner; service impersonation | Device owner mismatch denied; no elevated execution claim | Real Windows UAC/Windows token |
| ROOT deadline (899999 vs 900000 ms) and CORE indefinite preference | Lease expiration exact; policy remains `PAUSED_UNVERIFIED` | Session-bound 15-minute elevated delegation |
| GitHub OAuth CSRF state signature, wrong provider, wrong secret, cross-purpose, expiry | Invalid states rejected | **BLOCKED**: state verifier is stateless, currently accepts same still-valid state repeatedly and does not bind it to a browser-session nonce. A passing signature test is not CSRF replay proof. |
| Same-owner device re-pair; consumed/old pairing token, old credential, ROOT/CORE | Old device credential rejected, two old pairing challenges rejected, ROOT/CORE cleared | Actual physical device identity/re-pair/owner transfer verification |
| Two independently registered ChatGPT/Codex public clients | Cross-client refresh denied, wrong-owner access-token invalidation denied; unaffected second owner remains valid | Native signed-in ChatGPT or Codex staging sessions |
| Access-token-only revocation | Revoked token denied; original same-client refresh still valid **by design** | **BLOCKED**: full logout/refresh grant kill via trusted production owner/session epoch is not proven |

**Important CSRF limitation:** `issueOAuthState` produces an expiring HMAC bearer value and `verifyOAuthState` checks provider and expiration, but the current implementation does not persist an `state` nonce, bind to the original browser session, or consume its state once. The test intentionally records this fact instead of asserting a nonexistent replay rejection. Future implementation must test cross-browser callback/replay and proof of exact requester/session binding before claiming complete CSRF acceptance.

**Important elevation limitation:** signed web-session role `admin`, a valid MCP Bearer, CORE persistence, unexpired ROOT lease, reported Broker readiness, or Cloudflare OAuth success **cannot** alone be accepted by a privileged Windows Broker. Effective rights require a separately authenticated, protected Windows-side delegation rooted in a locally approved enrollment and current process token proof. Existing `authorization-explain` is read-only and always marks elevated execution not proven.

**Related existing fixtures:** #598 integrated #604 HTTP verifier negatives and #600 gzip parser admission; #608 independent combined Windows Job CI passed. The OAuth atomic-refresh, session-epoch, access verification and owner-transfer tests in existing `test/mcp-oauth-*staging.test.ts` are independent synthetic/SQLite proposal fixtures, not production session acceptance.

**Physical release gates:** authorized isolated staging issuer and test account, real ChatGPT and Codex independent PKCE logins with tool completion, refresh/revoke/CSRF replay across two browser sessions, owner transfer with trusted device-identity readback, signed protected locally approved Broker enrollment/revoke, UAC consent provenance, ROOT 15-minute delegation expiry and persistent CORE after restart without repeat prompt. No physical Windows elevation or live OAuth acceptance is claimed.
