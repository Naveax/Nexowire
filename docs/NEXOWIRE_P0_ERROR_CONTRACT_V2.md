# P0 Error Contract v2: provider / MCP / Agent failure attribution

This source-only patch is **additive**. It does not replace PR #538's Agent operation journal or PR #542's `taskStatus`, `taskSuccess`, `exitCode`, or UNKNOWN semantics. `ok:true` still describes a delivered Agent request, not proof of a successful shell command. MCP `isError` remains unchanged for nonzero shell exits.

## JSON contract

Errors gain `error.attribution`; completed shell/WSL invocations with failed, timed-out or unknown task outcome gain `diagnostic`, even with `ok:true`. Both are optional to preserve older clients. `contractVersion:2` introduces:
- `observedAt` (reporting layer); `causeLayer` (confirmed layer or `undetermined`); `certainty` (confirmed/unknown)
- `code`; `dispatchState` (not_dispatched/dispatched/unknown); `retrySafety` (read_only_retry/after_reauthorization/reconcile_first/manual_review)
- `correlationId`, `operationId` when known; `nextAction` is a conservative, reviewable remediation.

Layers: `upstream_client`, `mcp_hub`, `identity`, `device_connection`, `native_agent`, `windows_wsl`, `operation`, `task_verification`, `undetermined`. Cause attribution depends on **both the reporting boundary and a known error code, never raw prose**. A `PATH_DENIED`, shell exit, Windows UAC, connection or MCP-authorization code observed outside its trusted originating layer remains `undetermined`; code names alone are not provenance. Confirmation of a connection error does not confirm its underlying physical/root cause. No secret prompts, policies, or account decisions are inferred.

Retry actions distinguish `read_only_retry` for genuinely read-only requests from `reconcile_first` for mutating requests where the dispatch result might be unknown. A confirmed read-only PATH_DENIED requires fresh explicit scope (`after_reauthorization`), not a blind retry. A mutation never silently changes to another execution surface.

## Example decisions

| Evidence | Classification | Safe next action |
| --- | --- | --- |
| Mutation acknowledgement lost: `MUTATION_STATE_UNKNOWN` | observed by Hub, cause undetermined, dispatch unknown | Query original operation ID and readback; no blind retry |
| `UNAVAILABLE` without provider stage | undetermined | Check client/MCP/provider/device separately |
| `PATH_DENIED` at Agent | native Agent path authorization | Request explicitly scoped owner grant, **not a shell workaround** |
| `AuthRequiredError` | identity | Use intended OAuth issuer/client and authorization flow |
| `WINDOWS_UAC_DENIED` | Windows/UAC | Owner-approved elevation; no UAC bypass |
| Timeout after possible dispatch | cause undetermined | Reconcile before retrying side effects |
| Shell `ok:true,exitCode:1` | task outcome failed; `isError` remains unset | Inspect redacted stderr and independent postconditions |
| Upstream refusal before any tool dispatch | **not observable by Nexowire** | Client may explicitly attach `UPSTREAM_REFUSAL_NOT_DELIVERED` evidence; do not invent OpenAI private refusal rationale |

### Transparent alternatives for false blocks

Use read-only device listing and Agent operation-status/permission diagnostics. If the intended action is authorized, request a narrow path grant or official sign-in/consent in the original UI, then independently verify the target. Never change capability or encode a denied request to slip past policy. If a mutation may have executed, keep the existing request/operation ID and reconcile first.

## Redaction and boundaries

`redactDiagnosticText` and `redactDiagnosticValue` redact common bearer tokens, API keys, passwords, access/refresh tokens and PEM private keys in MCP structured/text outputs and new provider diagnostic messages, including bare `token=`, quoted multiword values and truncated private-key blocks. Unknown credential formats, arbitrary binary payloads or screenshots require separate data-loss-prevention controls. Correlation metadata must not include secrets.

This contract is not an authorization grant; it does not override upstream provider policies, Windows UAC, Agent grants or MCP authorization. Legacy clients ignore optional attribution fields. The live Agent 1.0.5 is not updated by this PR. Source tests, build and exact-head CI must be evaluated separately from deployed acceptance.
