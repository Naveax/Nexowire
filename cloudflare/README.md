# Cloudflare zero-owner-spend deployment

This directory contains the first hosted control-plane target.

Current state:
- static dashboard assets: ready;
- D1 schema: ready;
- D1 store adapter: ready;
- API handler: ready;
- GitHub OAuth user sign-in: ready;
- signed HttpOnly Nexowire sessions: ready;
- internal usage charging: protected by a separate service bearer token.

## Why one Worker

Cloudflare Workers Static Assets can serve the web dashboard and invoke the Worker first only for /api/* and /health. This keeps the deployment small and avoids a separate frontend server.

## First deployment steps

Before first deploy, create a GitHub OAuth app with callback URL:
   https://<your-worker-host>/auth/github/callback

Then:

1. create a D1 database:
   npx wrangler@latest d1 create nexowire-control-plane --update-config --binding DB
2. apply the migration:
   npx wrangler@latest d1 execute nexowire-control-plane --remote --file cloudflare/migrations/0001_control_plane.sql
3. apply the identity migration:
   npx wrangler@latest d1 execute nexowire-control-plane --remote --file cloudflare/migrations/0002_external_identities.sql
4. configure Worker secrets:
   npx wrangler@latest secret put GITHUB_CLIENT_ID
   npx wrangler@latest secret put GITHUB_CLIENT_SECRET
   npx wrangler@latest secret put NEXOWIRE_SESSION_SECRET
   npx wrangler@latest secret put NEXOWIRE_INTERNAL_SERVICE_TOKEN
   npx wrangler@latest secret put NEXOWIRE_ADMIN_GITHUB_ID
5. build Nexowire:
   npm run build
6. deploy:
   npx wrangler@latest deploy --config cloudflare/wrangler.jsonc

The checked-in config contains a placeholder database ID on purpose. No Cloudflare account secret or API token belongs in git.

## Financial invariant

Do not configure automatic paid upgrades. Free-capacity exhaustion must fail closed. Any future paid relay capacity must be funded only from already-collected prepaid/subscription revenue.
