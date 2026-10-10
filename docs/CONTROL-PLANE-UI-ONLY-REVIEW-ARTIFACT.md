# Verified UI-only review bundle (no deployment)

The existing manual `preflight-control-plane-ui-only.yml` verifies the exact last deployed backend source, compares live `app.js` and `styles.css` **raw bytes** against that immutable baseline, confirms that only those two assets change and there are no new backend API dependencies, then checks syntax/typecheck/build against the pinned backend.

After **all those checks pass**, the workflow now stages a fixed, minimal inspection artifact:

- `web/app.js` — candidate owner-facing Admin Bridge ON/OFF and CORE UI;
- `web/styles.css` — the candidate UI styles;
- `manifest.json` — pinned backend SHA, old/new SHA-256 hashes and byte counts, verified live baseline, and explicit `productionDeploymentPerformed:false`, `backendRuntimeAttested:false`.

A release gate verifies the manifest's exact pinned backend version, unchanged control-plane runtime attestation status, two known asset names and exactly **three files** in the staged artifact. A workflow `actions/upload-artifact@v4` step retains the bundle for seven days. The bundle intentionally contains **no D1/Worker executable or secrets**. The workflow still has `contents: read` only, no Cloudflare credentials and no deploy/migration action.

**This is an inspection package, NOT a production release or a secure Worker runtime attestation.** Actual deployment requires a separately owner-approved, independently checked current Cloudflare deployed runtime version, a reviewed assets-only rollout mechanism and the explicit acceptance of the app's preference-only ON/OFF semantics. The general production deploy workflow also runs migrations, and must not be substituted for this UI-only package.

No live Worker, D1, Windows task, Agent or ACL state is modified by generating this artifact.
