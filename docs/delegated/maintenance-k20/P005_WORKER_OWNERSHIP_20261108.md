# T-514 — P005 worker, task and path ownership audit (2026-11-08)

Source: fork `ekip/PANO.md` P005 from exact `5cb864e99773f79637c00fe3b18e8afe78724a7d` (read-only), owner main `b5a3f8840517d65ecbd6a018699c4c8bdde09987`. `auditP005Ownership` parsed the 20 worker sections.

**Result: 20/20 workers, 120/120 unique T-395…T-514 active/queue assignments, zero repeated T-ID, zero overlapping exact/wildcard owned paths.** Shared issue numbers are *intentional slices*, not path clashes; source roles that say read-only are not code permissions.

| Worker | Focus issues | P005 active + queue IDs | Declared paths |
| --- | --- | --- | --- |
| K01 | #485, #539 | T-395–T-400 | `web/connect.html`, `web/connect.js`, `test/delegated/k01/**` |
| K02 | #485, #539 | T-401–T-406 | `web/styles.css`, `test/delegated/k02/**` |
| K03 | #539, #812 | T-407–T-412 | `web/index.html`, `web/app.js`, `test/delegated/k03/**` |
| K04 | #539, #485 | T-413–T-418 | `web/admin.html`, `web/admin.js`, `test/delegated/k04/**` |
| K05 | #539, #485 | T-419–T-424 | `test/delegated/k05/**`, `scripts/delegated/k05/**`, `docs/delegated/qa-accessibility-k05/**` |
| K06 | #485, #269 | T-425–T-430 | `docs/INSTALL_WINDOWS.md`, `docs/CHATGPT_INSTALL_PROMPT.md`, `test/delegated/k06/**` |
| K07 | #485, #539 | T-431–T-436 | `docs/SELF_HOST.md`, `docs/DEPLOYMENT_ONBOARDING.md`, `test/delegated/k07/**` |
| K08 | #539, #812 | T-437–T-442 | `docs/ARCHITECTURE.md`, `docs/MCP_SURFACE.md`, `test/delegated/k08/**` |
| K09 | #539, #481, #780, #482 | T-443–T-448 | `ROADMAP.md`, `docs/SCALE_V2_ROADMAP.md`, `test/delegated/k09/**` |
| K10 | #539, #485, #812 | T-449–T-454 | `web/README.md`, `scripts/delegated/k10/**`, `test/delegated/k10/**`, `docs/delegated/browser-evidence-k10/**` |
| K11 | #487, #539 | T-455–T-460 | `scripts/report-s5-cost-matrix.ts`, `src/ops/scale-s5-cost-envelope.ts`, `test/delegated/k11/**` |
| K12 | #487, #539 | T-461–T-466 | `scripts/bench-s5-loopback-ws-capacity.ts`, `scripts/bench-s5-loopback-reconnect-storm.ts`, `test/delegated/k12/**` |
| K13 | #1006, #539 | T-467–T-472 | `.github/workflows/delegated-noncore.yml`, `scripts/delegated/k13/**`, `test/delegated/k13/**` |
| K14 | #1006, #539 | T-473–T-478 | `scripts/delegated/k14/**`, `docs/delegated/integration-k14/**` |
| K15 | #539, #812, #485 | T-479–T-484 | `test/delegated/k15/**`, `docs/delegated/device-ux-k15/**` |
| K16 | #540, #539 | T-485–T-490 | `src/diagnostics/environment-doctor.ts`, `scripts/run-environment-doctor.ts`, `test/delegated/k16/**` |
| K17 | #780, #539 | T-491–T-496 | `src/skills/manifest.ts`, `src/skills/registry.ts`, `test/delegated/k17/**` |
| K18 | #487, #588, #539 | T-497–T-502 | `src/ops/scale-transport-metrics.ts`, `scripts/report-s5-measured-scenarios.ts`, `test/delegated/k18/**` |
| K19 | #588, #539 | T-503–T-508 | `test/delegated/k19/**`, `docs/delegated/file-ux-k19/**` |
| K20 | #1006, #539, #540 | T-509–T-514 | `scripts/delegated/k20/**`, `test/delegated/k20/**`, `docs/delegated/maintenance-k20/**` |

The checker also injects two independent negative fixtures: duplicate task ID and duplicated owned path are detected. These 120 are **assigned**, not necessarily completed, and this report does not claim QA/CI/physical acceptance for any other worker.

Known **P004 pool** overlap remains a different class of duplicate: **T-385 belongs to K02** (smaller claimant). K20 and K16 must not claim that task twice. This is separately resolved in T-511; current P005 new task IDs have no duplicates.
