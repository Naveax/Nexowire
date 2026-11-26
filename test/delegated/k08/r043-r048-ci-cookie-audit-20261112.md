# K08 R-043–R-048: exact PR/CI and synthetic cookie boundary audit

Date: 2026-11-12 (Europe/Istanbul). Scope: read-only upstream evidence and K08-owned isolated probe only.

## Snapshot
- Upstream `Naveax/Nexowire@main`: `52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`.
- #1035: open Draft, `e0de00624b1de3c0564ebc37e2c50ae914259a4f`, two unique `test/delegated/pool-k08/**` paths, old CI run [41338306321](https://github.com/Naveax/Nexowire/actions/runs/41338306321): `action_required`, zero jobs.
- #1106: open Draft, previous HEAD `c9b574b1969ceeaa74c971dd4fc3b6c929964fa0`, docs + K08-owned tests/audits, run [42528140352](https://github.com/Naveax/Nexowire/actions/runs/42528140352): 7/7 generic jobs `success` (Node 22/24 included). This is not proof that new K08 nested tests ran.
- #1128: open Draft, `5f2b654d4c23d55a1ff3dd141f2117cb9e7f0872`, three unique status-vocabulary files; run [42411934421](https://github.com/Naveax/Nexowire/actions/runs/42411934421): 7/7 generic jobs `success`; status-vocabulary nested test absent from main workflow explicit K08 callsite.
- GitHub changed-path lists for all three do not intersect. Their conceptual overlap on empty-device status is not duplicate test files. Preserve the #1035 redaction probe and #1128 six-level Turkish evidence glossary.
- #1068 owns `web/app.js` source. Current main blob `30ae81538b92fe8169031eccd1dbda41117d2f3c` still contains both `setPill('Bağlı', 'good')` and `Henüz bağlı cihaz yok`. Source contradiction remains; browser acceptance NOT_RUN.
- Main `.github/workflows/ci.yml` blob `90185b6f4297bc3e4feaca44817ed6a8248bd4be` explicitly selects only `mcp-doc-contract.test.mjs`, `mcp-doc-fences-endpoints.test.mjs`, `mcp-output-language.test.mjs` under `test/delegated/k08/`; newer K08 files are HOSTED_NOT_SELECTED. K13/owner must decide discovery.
- #1096 owns protected CORE/auth/SQLite and main CI. No source changes to those areas.

## R-043/R-045: focused source-backed regression probe
The upstream current-main `src/protocol/error-contract-v2.ts` blob `34d88bd5bd9bc6a9bc63b98a9066ee557ade372a` has a `sensitiveKey` regex omitting `cookie` and `set-cookie`. Text redaction patterns likewise do not explicitly match those keys. The isolated `test/delegated/k08/diagnostic-cookie-probe.mjs` uses only synthetic marker data and checks the existing safe redaction baseline, followed by Cookie/Set-Cookie handling. Its result is not asserted as PASS: the fully integrated Node+TS execution was **NOT_RUN** in this environment; syntax check of locally identical content using `node --check` succeeded (Node 22.16.0). GitHub automatically queued run `43285341595` for commit `43a9af4adf88da158dff2cecf143d1bd456ea22f`, but the new probe was not added to required CI's explicit selection, so that run cannot establish probe PASS. The test is intentionally nondefault and may exit 1 once invoked. This documents a potential redaction boundary regression, not proven real-world propagation from incoming HTTP headers to MCP diagnostic result.

Owner handoff: security owner should inspect whether raw Cookie/Set-Cookie metadata can actually reach the diagnostic helper, decide if key-name masking is required, implement the remedy in protected source if appropriate, then explicitly run the synthetic probe and preserve its positive/negative evidence. Do not force a change to permission, auth or user session behavior based only on this source-level observation.

## Acceptance boundary
Offline static/source scan: inspected. Executed isolated TS probe: NOT_RUN. Hosted new K08 nested tests: NOT_SELECTED by current main workflow. Real MCP provider, Agent/Hub, browser, Windows device, installed binary and operation readback: NOT_RUN. No CI rerun, no upstream merge, no issue closure, no new PR.
