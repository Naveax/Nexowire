# K09 offline version-reference candidates (T-124)

From the repository root, run:

```sh
node scripts/delegated/versions-k09/version-reference-report.mjs --release v1.0.8 --as-of 2026-11-01
node scripts/delegated/versions-k09/version-reference-report.test.mjs
```

The release baseline and date are explicitly **caller supplied**; verify them through the official GitHub release before running. The tool reads only `README.md`, `docs/CHATGPT_INSTALL_PROMPT.md`, and `docs/INSTALL_WINDOWS.md`, prints deterministic JSON, and does not access the network or write files. It is a **candidate review**, not an assertion that an older version is inherently wrong. `HISTORICAL_CONTEXT` preserves dated rollback/archive references; `POTENTIAL_STALE_GUIDANCE` asks a document owner to check active instructions; `OLDER_REFERENCE_REVIEW` is an ambiguous older reference; `FUTURE_VERSION_REVIEW` requests a provenance check.

2026-11-01 finding against observed published release v1.0.8: `docs/CHATGPT_INSTALL_PROMPT.md:24` still directs a newly onboarding user to the published v1.0.7 installer. The file belongs to **K06** under the team protocol; K09 **did not edit it**. Ask K06/ŞEF to check whether the branch-specific historical guide should instead link the current `docs/INSTALL_WINDOWS.md` official installer. A real install, signature check, or repair/rollback is **NOT_RUN**.
