# Scale v2 S4 — One-shot Custom Usage pre-checkout gate (DEV, NOT LIVE)

**2026-10-15.** Following staged disclosures PR #512 (squash merged into main `18fbf437d27a6339bd2705c8f447626cade97c64`). User requested user-visible limits and affirmative, versioned approvals before signup and purchase, with **100–850,000 calls/day** and a default **600 MCP requests/minute**, shared by the same OpenAI Secure MCP Tunnel + calling app. The rate is a transport ceiling, NOT a throughput guarantee. Current active Free policy remains **1,000 weighted credits per UTC month**, not daily, and live checkout is OFF.

## New code, separated from billing

- `src/product/custom-usage-checkout-gate-proposal.ts` is NOT imported by live GitHub OAuth, `BillingService.createCheckout`, Workers, Hub or Agent.
- Owner-controlled staging SQLite table `proposed_custom_checkout_offers` stores server-issued immutable, short-lived signed offers linked to **trusted authenticated account**, offer nonce, exact user-visible offer hash, price/currency/merchant/cancel URL, daily selected quota, document versions and expiry. No purchaser-supplied quote/price is trusted.
- `gate.issue` creates a signed offer and persists it. `gate.accept` checks the browser's *displayed SHA256 offer hash* matches the stored original offer, then calls the independent signed receipt verifier from PR #512. The user must individually check Terms, throughput limitation and purchase pre-information; optional marketing remains separate. Privacy notice is not blanket KVKK consent.
- `gate.reserveSandboxIntent` **rechecks** trusted owner identity, exact current seller/product/price/terms versions, legal approval flag, sandbox-only flag, expiry, stored affirmative receipt, and unreserved state **inside a single `BEGIN IMMEDIATE` transaction**. Competing consumers cannot reserve the same nonce twice. Any missing database table, bad clock or unknown state refuses.
- Reservation is **NOT permission for the real payment provider**; returned `providerCheckoutAllowed:false`, no checkout URL, no account entitlement write and no subscription provisioning.
- Once reserved, a user must be issued a *new quote and explicitly reaccept* to attempt another purchase. The receipt is immutable for the original signed quote; a changed price or legal revision requires another offer/consent.
- All price, merchant and document details in tests are **synthetic placeholders**, not actual current Nexowire seller/product claims. Never flip `legallyApproved` or `sandboxCheckoutEnabled` on a production route merely to pass a CI test.

## Acceptance

`node --test --import tsx test/custom-usage-checkout-gate-staging.test.ts`: 12/12; exact quote+consent, missing each required checkbox, price/quota/seller/terms/cancel mismatch, legal/sandbox disabled, forged browser display hash, wrong account, expired quote/acceptance, idempotent receipt & duplicate checkout, unavailable DB/clock, multi-instance one-shot, no provider URL/plan grant.

An additional combined test suite should exercise staged offer+consent+quota and the unchanged live billing route in isolation. GitHub exact-head 7/7 CI required to merge.

## Hard NO-GO

**No activation** until legal counsel approves actual merchant identity, age/minor eligibility, KVKK data inventory and separate valid notices, required commerce contract/full terms and durable records, tax-inclusive price, renewal/refund/cancellation/withdrawal rules and international jurisdictions.

**No real checkout** until OAuth identity/CSRF, authenticated account quote issuance and receipt write are integrated in the owner-operated backend with durable storage/replication, transaction isolation, signed document archive, server-only merchant pricing catalog, short quote expiry and customer-visible immutable version IDs. The existing Checkout Plus/Pro API must not silently bypass final required acceptance when a separately approved production feature flag is introduced.

**No 850,000/day guarantee** without 24h sustained real transport + Agent load testing, shared 600/min limit for *all* MCP requests including handshake/metadata/failed requests and measured $0 incremental operator-cloud-invoice boundary. Existing daily Custom Usage, Plus/Pro and paid plans remain OFF.

No live account creation acceptance, checkout, customer funds, Cloudflare/Tailscale route or Native Agent processes are changed by this PR. S6 remains deferred.
