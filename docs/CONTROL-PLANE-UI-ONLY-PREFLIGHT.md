# UI-only production release preflight (does NOT deploy)

The user-visible Admin Bridge ON/OFF quick button, large PC Settings switch, separate AUTO selection and truthful Broker preference-vs-runtime warning are merged in the repository, but the live Worker still serves an older dashboard. The general-purpose `.github/workflows/deploy-control-plane.yml` is **not** safe as an assets-only shortcut: it applies every D1 migration and deploys the latest Worker backend.

The manual `.github/workflows/preflight-control-plane-ui-only.yml` is intentionally **read-only**. It checks out the source commit whose `web/app.js`, `web/styles.css` and `web/index.html` bytes were observed matching live on 2026-10-26 `d6bf09a4da37042096427d415782902b97e5e87a` (workflow `38053819099`), stages only `web/app.js` and `web/styles.css` from reviewed current source, then:
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


## Updated live asset provenance, 2026-10-26

Read-only HTTPS SHA-256 compared all three production static assets against repository commit `d6bf09a4da37042096427d415782902b97e5e87a`:
- `web/app.js`: `4edfd9fff217908b811ba42d94441f9d5fa4e08705a523a52ec5a30828d1f792`
- `web/styles.css`: `5067d1dd4fea73c8b7777eed7ae373df9cc9e17e4d2f579c2f5e21df866b4034`
- `web/index.html`: `9d22422bc0e6e292a039fe6dc33d28bd035510c1d844913a6b95fa0f929e71f1`

These are static **asset** matches, not Cloudflare Worker runtime attestation. The formerly pinned `6f5863363b4ad25bbecceca5b5c78e8ffdd8fffd` is no longer the current live asset baseline; the read-only workflow run 40332709418 correctly rejected it with `UI_ONLY_LIVE_BASELINE_MISMATCH:web/app.js`.

The candidate frontend now references `/api/v1/me/devices/core-enrollment-request`, which the observed live frontend baseline lacks. A UI-only preflight must still **reject** this new backend API requirement via `UI_ONLY_NEW_BACKEND_API_REQUIRED`. Do not weaken the API guard or deploy just the static files; use a separately reviewed backend migration/production release path after independently verifying the Worker runtime and existing D1 schema.

The current stylesheet happens to equal the observed live stylesheet byte-for-byte. A future read-only preflight may therefore legitimately modify only `web/app.js`, while still staging/checking both assets and verifying the exact diff set. The workflow does not deploy anything.
