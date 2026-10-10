# UI-only production release preflight (does NOT deploy)

The user-visible Admin Bridge ON/OFF quick button, large PC Settings switch, separate AUTO selection and truthful Broker preference-vs-runtime warning are merged in the repository, but the live Worker still serves an older dashboard. The general-purpose `.github/workflows/deploy-control-plane.yml` is **not** safe as an assets-only shortcut: it applies every D1 migration and deploys the latest Worker backend.

The manual `.github/workflows/preflight-control-plane-ui-only.yml` is intentionally **read-only**. It checks out the exact successful deployed backend source `6f5863363b4ad25bbecceca5b5c78e8ffdd8fffd` (workflow `38053819099`), stages only `web/app.js` and `web/styles.css` from reviewed current source, then:
1. Confirms the staged base is exactly the pinned deployed backend commit.
2. Confirms the only modified tracked files are the two allowlisted static assets.
3. GETs the live `app.js` and `styles.css` over HTTPS with cache-busting and compares **raw UTF-8 bytes** to those pinned files. PowerShell `Invoke-WebRequest.Content` text decoding can replace Turkish characters and produce misleading text diffs: compare bytes, not decoded text.
4. Refuses new `/api/v1/...` endpoint references, oversized assets or missing Admin Bridge ON/OFF controls.
5. Runs Node syntax check, `npm ci`, TypeScript check and build against the **old backend** with the staged new assets.
6. Prints a SHA-256 manifest, `productionDeploymentPerformed:false`, `backendRuntimeAttested:false`.

The runner is granted `contents: read` only, receives **no Cloudflare credentials or D1 token**, and contains **no deploy/migration action**. A successful preflight is not a production rollout. It also does not cryptographically attest the current deployed Worker runtime code merely because the two live assets match; that requires an independent owner-verified Cloudflare deployment-version check before any future real release.

## Verified on work-pc, 2026-10-10

Local UI-only stage:
`C:\Users\umut\source\Nexowire-prod-ui-only-stage-20261010`

Live raw asset bytes matched pinned deployed commit, no new API paths were referenced, and the pinned backend plus candidate UI passed syntax/typecheck/build. No Worker, D1, secrets, Windows ACL or Agent task were modified.

The next actual production release must use a **separately owner-approved, separately reviewed deployment workflow** and an exact production-version check. Do not run the general full-stack deployment pipeline or apply source migrations 0017/0018 merely to surface a UI toggle.

Even after the UI is deployed, ON/OFF remains **preference-only**. Local OS execution requires an independently protected Guardian, signed device receipts, owner-approved Hub commands, durable local replay and closure of P0 issue #271.
