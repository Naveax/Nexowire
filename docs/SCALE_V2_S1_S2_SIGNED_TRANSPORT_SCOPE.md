# Scale v2 — Operator-signed MCP transport-scope assertions (S1/S2, STAGING ONLY)

**2026-10-16.** The prior all-ingress, rolling 600/min owner-hosted SQLite staging implementation passed CI 7/7 and merged from PR #514 as main `b4e09fccc4b59ada5bb4b4a3a161a7e6d0e57dcb`. This document explains the next **isolated opt-in security prototype**; it does not alter live Cloudflare, Tailscale, ChatGPT MCP registration, product entitlements, free credit policy or Native Agents.

## Why this is required

A user can send arbitrary `Host`, `X-Tunnel-ID`, `Origin`, `Authorization`, or tool arguments. None proves which OpenAI Secure MCP Tunnel and calling application a tool request belongs to. A forged client-selected scope would artificially multiply a shared 600/minute bucket.

`src/mcp/signed-transport-scope-proposal.ts` models a **private-operator signer / public-origin verifier** boundary using Ed25519. The trusted control-plane signer (NOT a user PC, and NEVER the public origin) signs a canonical, allowlisted claim binding:

- audience `nexowire-local-first-mcp`, schema version 1;
- trusted issuer name and pinned signer key ID;
- authenticated **tunnel ID**, **application ID** or explicit **user fallback** (based on the provider's verified caller metadata);
- exact HTTPS MCP resource URL (`/mcp`), routing generation, creation/expiration times;
- maximum 15-minute validity, 30-second pre-issuance clock tolerance, no unsigned extra claim fields.

The origin receives only the **signed assertion and operator public key**; it must get the expected issuer, key ID, HTTPS resource and minimum routing generation from independent, authenticated operator configuration. Verification checks public-key signature, exact resource, expiry and generation; budget scope is derived using a domain-separated SHA-256 digest without exposing raw tunnel/user/app IDs to the ledger or logs.

The helper `createSignedStagingTransportBudget` verifies at construction and on **each inbound arrival**, including a fresh trusted operator-owned `minimumRouteGeneration()` value. Expired assertions, signature/key/resource changes or a higher trusted generation block the local forwarding attempt, responding 503 through the optional staging ingress hook.

**No production private keys are generated or shipped by this PR.** The `issueOperatorRouteAttestation` signing function exists solely as a unit-test / DEV primitive and cannot be treated as an authenticated, deployed identity provider.

## What this proves vs what it does not

**Proven locally:** An attacker without the operator's private key cannot alter an already operator-signed caller/tunnel/resource scope. Forged HTTP headers don't create separate rate ledgers. Independent caller identities have separate cryptographically derived scopes **only if** the trusted owner genuinely authenticated those identities before signing them. The Ed25519 public key cannot create new signatures. A revoked generation is denied when its trusted state source returns the updated generation, or after assertion expiry.

**NOT proven:** The available OpenAI Secure MCP Tunnel actually exposes a trustworthy per-invocation caller application ID to Nexowire; the platform's API must be checked. A valid signature proves the owner signer asserted a value, **not** that OpenAI verified that value. The origin cannot enforce OpenAI provider counters already consumed upstream. An operator key stored only on a user's untrusted PC is NOT a safe SaaS signing authority; a user who changes their own binary can bypass local request gates. The signed scope does not authorize an MCP tool, account, command, payment, feature or subscription.

**NO immediate remote revocation guarantee:** A `minimumRouteGeneration` accessor must read a strongly authenticated, sufficiently fresh operator state. Cached/offline/compromised state is an unresolved production gate; the signed 15m TTL is a maximum lifetime in this DEV proof, not a production acceptable revocation SLA. Fail closed if operator state is unavailable, and require canonical device/owner OAuth revocation separately.

## Usage and verification

- **12/12 new route tests and 86/86 combined regression tests PASS** locally on Windows Node 22+, including renewed assertions sharing one budget and the operator public key being unusable for signing. Unit tests `test/signed-transport-scope-staging.test.ts` generate ephemeral **DEV Ed25519** keys only in the test process. Tests cover valid scope binding, forged tunnel/calling-app/caller-kind/resource, wrong pinned key/issuer/route generation, expired/future/overlong attestations, invalid payload encoding, other key algorithms, runtime operator generation changes, spoofed per-request scopes, and an actual mock loopback HTTP ingress returning 503 when a signed route expires.
- Existing shared-budget tests use an independently controlled operator scope; this new proposal provides one compatible **optional constructor** for the same staging-only interface. No automatic changes to the CLI or Hub, and no extra user-visible configuration or persisted credentials.

## Acceptance requirements before rollout

1. Document the real OpenAI Secure MCP Tunnel or alternative named HTTPS tunnel **identity metadata contract**, and determine whether signed per-app caller identity is available. If not, select a correctly shared coarse scope and be explicit about capacity.
2. Operator-controlled key custody, verification-key pinning, rotation and compromised-key revocation; do not expose a private key in public repository, native Agent, logs, URL, browser or customer machine.
3. Trusted issuance only AFTER provider-verified caller, first-party account OAuth+device ownership, mapped stable public HTTPS resource and subscribed entitlement. Use a short-lived authenticated channel to deliver a signed assertion and current operator generation to the origin, with secure offline behavior.
4. The authoritative global shared 600/min provider budget must work across **all clients and machines** under the same provider scope, not several unrelated local SQLite DBs. Provider-side counts may include calls refused before reaching origin.
5. Real paid subscription, Full/Root/CORE approval gates, call quota, signed owner cancellation, 850,000/day sustained load and zero-new-operator-cloud-bill acceptance remain separate and disabled.

**Production remains Free-only 1,000 weighted credits per UTC month.** Future daily Free/Plus/Pro and selectable 100–850,000 Custom Usage are **OFF**. No public remote MCP or real payment is enabled by this signed-route staging test.
