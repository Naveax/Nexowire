# Cloudflare zero-owner-spend deployment

This directory contains the hosted Nexowire control-plane target.

Current state:
- static dashboard and one-click connect UI;
- D1 accounts, devices, quota subjects, usage ledger and OAuth persistence;
- GitHub OAuth user sign-in;
- signed HttpOnly Nexowire sessions;
- MCP OAuth 2.1 / PKCE support;
- internal device authentication and usage charging;
- optional Lemon Squeezy Plus/Pro hosted checkout, signed subscription webhooks, and customer portal integration;
- admin-provisioned Custom prepaid plans with one-time Lemon Squeezy credit-pack checkout and carry-over credit balances;
- no automatic paid infrastructure upgrade.

## Production topology

The Cloudflare Worker serves the control plane and static assets. The user's Nexowire Hub remains the MCP / native-agent data plane.

Required public endpoints:
- control plane: Cloudflare Worker URL;
- MCP resource: `https://<hub-host>/mcp`;
- native agent: `wss://<hub-host>/agent`.

The Worker runs first for:
- `/api/*`
- `/auth/*`
- `/oauth/*`
- `/.well-known/*`
- `/health`

## Recommended first deployment

On the Windows owner machine, use:

`npm run control-plane:bootstrap`

The bootstrap:
1. checks Wrangler authentication and opens the Cloudflare OAuth authorization flow when needed;
2. discovers the live Nexowire Funnel MCP/agent endpoints;
3. resolves or creates the `nexowire-control-plane` D1 database;
4. generates the session, internal-service, and runtime-config encryption secrets locally;
5. stores those owner secrets in purpose-bound CurrentUser DPAPI envelopes;
6. generates a secret-free Wrangler runtime config;
7. applies every migration in `cloudflare/migrations`;
8. deploys the Worker and static assets;
9. opens a short-lived GitHub App Manifest setup page;
10. stores only the GitHub OAuth client ID/secret needed for sign-in, encrypted in D1;
11. wires the live Hub to the control plane through a protected service-token reference;
12. verifies control-plane health and MCP OAuth protected-resource metadata.

The generated GitHub App requests no repository permissions or repository events. The manifest response's private key and webhook secret are deliberately discarded.

The current migration chain includes:
- `0001_control_plane.sql`
- `0002_external_identities.sql`
- `0003_quota_subject_device_anchor.sql`
- `0004_device_credential_lookup.sql`
- `0005_mcp_oauth.sql`
- `0006_runtime_config.sql`
- `0007_billing_subscriptions.sql`
- `0008_prepaid_credit_balance.sql`

## GitHub Actions deployment

For later CI-driven deployments, use:

`.github/workflows/deploy-control-plane.yml`

It resolves/creates D1, generates runtime config, applies all migrations, deploys Worker/static assets, and removes temporary deployment material.

## GitHub Actions secrets

Configure these repository secrets only when using the CI deployment workflow:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `NEXOWIRE_SESSION_SECRET`
- `NEXOWIRE_INTERNAL_SERVICE_TOKEN`
- `NEXOWIRE_CONFIG_ENCRYPTION_KEY`

Optional Lemon Squeezy billing secrets, configured together with the billing variables below:

- `NEXOWIRE_LEMONSQUEEZY_API_KEY`
- `NEXOWIRE_LEMONSQUEEZY_WEBHOOK_SECRET`

For the Windows owner bootstrap, prefer DPAPI-protected files instead of plaintext environment values:

- `NEXOWIRE_LEMONSQUEEZY_API_KEY_DPAPI_FILE` using purpose `billing-lemonsqueezy-api-key`
- `NEXOWIRE_LEMONSQUEEZY_WEBHOOK_SECRET_DPAPI_FILE` using purpose `billing-lemonsqueezy-webhook-secret`

The protected-secret CLI reads plaintext only from stdin; secret command-line arguments are intentionally unsupported.

`NEXOWIRE_GITHUB_CLIENT_ID` and `NEXOWIRE_GITHUB_CLIENT_SECRET` remain optional for backward compatibility. New deployments should use the protected GitHub App Manifest setup instead.

Never commit secret values or place them in `wrangler.jsonc`.

## GitHub Actions variables

Configure:

- `NEXOWIRE_AGENT_WS_URL=wss://<hub-host>/agent`
- `NEXOWIRE_MCP_RESOURCE_URL=https://<hub-host>/mcp`
- `NEXOWIRE_ADMIN_GITHUB_ID=<numeric GitHub account id>`
- `NEXOWIRE_FREE_CAPACITY_PERCENT=0..100`

Optional Lemon Squeezy billing variables, configured together:

- `NEXOWIRE_LEMONSQUEEZY_STORE_ID=<numeric store id>`
- `NEXOWIRE_LEMONSQUEEZY_PLUS_VARIANT_ID=<numeric variant id>`
- `NEXOWIRE_LEMONSQUEEZY_PRO_VARIANT_ID=<numeric variant id>`

Optional prepaid pack mapping, only when the base Lemon Squeezy billing configuration above is present:

- `NEXOWIRE_LEMONSQUEEZY_PREPAID_PACKS_JSON=[{"variantId":"3001","credits":100000,"label":"100k kredi"}]`

The pack mapping is not a price table. Variant pricing stays in Lemon Squeezy. Nexowire maps only an approved one-time variant ID to the number of prepaid usage credits granted after a signed `order_created` webhook. Purchased credits carry across monthly usage periods and are debited atomically from a quota-subject balance.

Signed `order_refunded` webhooks claw back prepaid credits proportionally from Lemon Squeezy's cumulative refunded amount. If refunded credits were already spent, Nexowire records the remainder as refund debt, blocks further prepaid usage, and applies later top-ups to that debt before making any new credits spendable. Subscription-order refunds that do not match a recorded prepaid purchase are ignored by the prepaid ledger.

If none of the Lemon Squeezy settings are present, billing routes stay disabled with `503 BILLING_NOT_CONFIGURED` and the Free-plan control plane continues normally. Partial billing configuration is rejected.

The MCP resource URL points at the Hub, not the Cloudflare Worker.

## Local preparation

The checked-in `cloudflare/wrangler.jsonc` deliberately contains a placeholder D1 database ID. Production config is generated with:

`node scripts/prepare-cloudflare-control-plane.mjs`

The generated `wrangler.runtime.json` and `.wrangler/*` deployment material are ignored by git.

## Financial invariant

Nexowire must not auto-upgrade to paid provider capacity. Free-capacity exhaustion fails closed. Any future paid relay capacity must be funded from already-collected subscription/prepaid revenue rather than owner-paid overage.
