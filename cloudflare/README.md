# Cloudflare zero-owner-spend deployment

This directory contains the hosted Nexowire control-plane target.

Current state:
- static dashboard and one-click connect UI;
- D1 accounts, devices, quota subjects, usage ledger and OAuth persistence;
- GitHub OAuth user sign-in;
- signed HttpOnly Nexowire sessions;
- MCP OAuth 2.1 / PKCE support;
- internal device authentication and usage charging;
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

## Recommended deployment

Use the repository workflow:

`.github/workflows/deploy-control-plane.yml`

It:
1. validates required secrets/variables;
2. resolves or creates the `nexowire-control-plane` D1 database;
3. generates `wrangler.runtime.json` without copying secret values into it;
4. applies every migration in `cloudflare/migrations`;
5. deploys the Worker and static assets;
6. removes generated secret/runtime material.

Do not manually apply individual migrations unless debugging. The current migration chain includes:
- `0001_control_plane.sql`
- `0002_external_identities.sql`
- `0003_quota_subject_device_anchor.sql`
- `0004_device_credential_lookup.sql`
- `0005_mcp_oauth.sql`

## GitHub Actions secrets

Configure these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `NEXOWIRE_GITHUB_CLIENT_ID`
- `NEXOWIRE_GITHUB_CLIENT_SECRET`
- `NEXOWIRE_SESSION_SECRET`
- `NEXOWIRE_INTERNAL_SERVICE_TOKEN`

The GitHub OAuth App callback must be:

`https://<control-plane-worker-host>/auth/github/callback`

Never commit these values or place them in `wrangler.jsonc`.

## GitHub Actions variables

Configure:

- `NEXOWIRE_AGENT_WS_URL=wss://<hub-host>/agent`
- `NEXOWIRE_MCP_RESOURCE_URL=https://<hub-host>/mcp`
- `NEXOWIRE_ADMIN_GITHUB_ID=<numeric GitHub account id>`
- `NEXOWIRE_FREE_CAPACITY_PERCENT=0..100`

The MCP resource URL points at the Hub, not the Cloudflare Worker.

## Local preparation

The checked-in `cloudflare/wrangler.jsonc` deliberately contains a placeholder D1 database ID. Production config is generated with:

`node scripts/prepare-cloudflare-control-plane.mjs`

The generated `wrangler.runtime.json` and `.wrangler/*` deployment material are ignored by git.

## Financial invariant

Nexowire must not auto-upgrade to paid provider capacity. Free-capacity exhaustion fails closed. Any future paid relay capacity must be funded from already-collected subscription/prepaid revenue rather than owner-paid overage.
