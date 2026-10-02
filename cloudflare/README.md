# Cloudflare zero-owner-spend deployment

This directory contains the first hosted control-plane target.

Current state:
- static dashboard assets: ready;
- D1 schema: ready;
- D1 store adapter: ready;
- API handler: ready;
- production user authentication: intentionally fail-closed and not enabled yet.

## Why one Worker

Cloudflare Workers Static Assets can serve the web dashboard and invoke the Worker first only for /api/* and /health. This keeps the deployment small and avoids a separate frontend server.

## First deployment steps

Do not deploy until authentication lands.

When auth is ready:

1. create a D1 database:
   npx wrangler@latest d1 create nexowire-control-plane --update-config --binding DB
2. apply the migration:
   npx wrangler@latest d1 execute nexowire-control-plane --remote --file cloudflare/migrations/0001_control_plane.sql
3. build Nexowire:
   npm run build
4. deploy:
   npx wrangler@latest deploy --config cloudflare/wrangler.jsonc

The checked-in config contains a placeholder database ID on purpose. No Cloudflare account secret or API token belongs in git.

## Financial invariant

Do not configure automatic paid upgrades. Free-capacity exhaustion must fail closed. Any future paid relay capacity must be funded only from already-collected prepaid/subscription revenue.
