# Nexowire MCP Surface Compatibility

Nexowire exposes a versioned ChatGPT-facing MCP surface independently from the native-agent wire protocol.

## Current versions

- MCP surface: **v1**
- Native-agent protocol: reported separately by `nexowire_surface_info`

These versions solve different compatibility problems. A native-agent protocol bump does not automatically require an MCP surface bump, and adding a new MCP tool does not automatically require either bump.

## Tool names, read-only capabilities, and permissions

The **MCP tool name** is not the same as an Agent capability name. The v1
compatibility floor is defined in [`src/mcp/surface.ts`](../src/mcp/surface.ts),
tool-to-capability mappings in
[`src/mcp/tool-capabilities.ts`](../src/mcp/tool-capabilities.ts), and the
Agent's read-only capability classification in
[`src/protocol/capabilities.ts`](../src/protocol/capabilities.ts).
The matrix below is the intersection of those three sources. Rechecked on
2026-11-08 at upstream `main` `b5a3f8840517d65ecbd6a018699c4c8bdde09987`
after the source integration in [PR #1066](https://github.com/Naveax/Nexowire/pull/1066). It is checked by
[`test/delegated/k08/mcp-doc-contract.test.mjs`](../test/delegated/k08/mcp-doc-contract.test.mjs).

**Read-only here means that the mapped Agent capability is in
`READ_ONLY_CAPABILITIES`; it does not grant anyone permission to invoke it.**
Tool allowlists, device selection, authorization, online capabilities, and
additional operation-specific restrictions still apply. A read-only network
probe can generate network traffic; a read can reveal sensitive data to an
already-authorized caller. This is a *classification*, not a security approval.

<!-- k08:read-only-v1-begin -->
| Stable MCP v1 tool | Read-only Agent capability |
| --- | --- |
| `agent_operation_status` | `agent.operation.status` |
| `browser_screenshot` | `browser.screenshot` |
| `browser_session_list` | `browser.session.list` |
| `browser_snapshot` | `browser.snapshot` |
| `browser_tabs` | `browser.tabs` |
| `browser_visual_verify` | `browser.visual.verify` |
| `file_hash` | `files.hash` |
| `file_list` | `files.list` |
| `file_read` | `files.read` |
| `file_read_many` | `files.read_many` |
| `file_stat` | `files.stat` |
| `machine_health` | `machine.health` |
| `machine_snapshot` | `machine.snapshot` |
| `network_dns_resolve` | `network.dns.resolve` |
| `network_http_probe` | `network.http.probe` |
| `network_tcp_probe` | `network.tcp.probe` |
| `process_list` | `process.list` |
| `process_read` | `process.read` |
| `runbook_get` | `runbook.get` |
| `runbook_list` | `runbook.list` |
| `search_text` | `search.text` |
| `task_artifact_list` | `task.artifact.list` |
| `task_artifact_verify` | `task.artifact.verify` |
| `task_graph_get` | `task.graph.get` |
| `task_graph_list` | `task.graph.list` |
| `verify_assertions` | `verify.assertions` |
| `windows_accessibility_find` | `windows.accessibility.find` |
| `windows_accessibility_tree` | `windows.accessibility.tree` |
| `windows_clipboard_read` | `windows.clipboard.read` |
| `windows_environment_list` | `windows.environment.list` |
| `windows_environment_read` | `windows.environment.read` |
| `windows_eventlog_query` | `windows.eventlog.query` |
| `windows_firewall_rules` | `windows.firewall.rules` |
| `windows_network_snapshot` | `windows.network.snapshot` |
| `windows_pointer_position` | `windows.pointer.position` |
| `windows_processes` | `windows.processes` |
| `windows_registry_read` | `windows.registry.read` |
| `windows_screenshot` | `windows.screenshot` |
| `windows_services` | `windows.services` |
| `windows_tasks` | `windows.tasks` |
| `windows_window_list` | `windows.window.list` |
| `workspace_detect` | `workspace.detect` |
| `workspace_snapshot` | `workspace.snapshot` |
<!-- k08:read-only-v1-end -->

This table deliberately **excludes** mutation-capable tools such as
`file_write`, `shell_exec`, `windows_window_focus`, and `browser_session_start`.
It also does not automatically classify Hub-local tools with no Agent
capability mapping: for example, `nexowire_surface_info` is implemented in
[`src/mcp/create-server.ts`](../src/mcp/create-server.ts) and operates locally;
`device_alias_set` changes Hub state. Neither belongs in the Agent read-only
matrix. The v1 stable set contains both read and write tools; its purpose is
**compatibility**, not blanket read-only behavior.

## Interpreting outputs without inventing success

The frozen output profile in
[`src/mcp/v1-output-contract.json`](../src/mcp/v1-output-contract.json)
distinguishes **native execution** tools such as `machine_snapshot` and
`file_write` from **Hub-object** tools such as `nexowire_surface_info` and
`device_alias_set`. These names are present in both the frozen
[`input contract`](../src/mcp/v1-input-contract.json) and the output contract.

| Signal | Evidence-based meaning | Not proof of |
| --- | --- | --- |
| Native `structuredContent.ok === true` | A native capability reported successful execution | Business-task acceptance or independent postcondition |
| Native `structuredContent.ok === false`, MCP `isError` | The capability reported an error; inspect its structured error | That a dispatched mutation had no side effects |
| `structuredContent.error` | Optional code/message on a native failure | Verified root cause of every underlying system failure |
| `structuredContent.idempotency` | Optional replay/key metadata | Permission to repeat an `UNKNOWN` mutation |
| Hub-object output | Tool-specific fields, e.g. `nexowire_surface_info.mcpSurfaceVersion` | A native `ok` field, online Agent, or granted device permission |

`isError` is a field on the **MCP tool result**, not automatically a member of
`structuredContent`. The compatibility contract records output *shapes* and
stable meanings, not a guarantee that calling a tool completed the user's
larger workflow.

For an ambiguous mutation, the error classification in
[`src/protocol/error-contract-v2.ts`](../src/protocol/error-contract-v2.ts)
uses `retrySafety: "reconcile_first"`: query the original operation and read
back the target state before deciding what to do. A cancellation, transport
timeout, lost response, or `UNKNOWN` status after possible dispatch is **not**
an automatic `succeeded` or `failed` verdict. Only proven
`not_dispatched` has a stronger no-dispatch claim. Likewise, the
`audit_query` input filter's `started`/`succeeded`/`failed` status vocabulary
must not be mistaken for a universal list of possible execution outcomes.

An illustrative *failure shape* (not a live Agent capture):

```json
{
  "ok": false,
  "error": {
    "code": "MUTATION_STATE_UNKNOWN",
    "message": "Outcome unconfirmed; reconcile original operation before retrying."
  }
}
```

The example deliberately makes no claim that the mutation failed or that a
retry is safe. Tool-specific response details remain governed by their actual
input/output contracts.

## Diagnosing an error without confusing its origin (#539 R01/R13/R18)

Use the evidence fields in
[`src/protocol/error-contract-v2.ts`](../src/protocol/error-contract-v2.ts):
`observedAt` is the place **actually observed**, `causeLayer` is an
evidence-supported attribution (or `undetermined`), `certainty` qualifies that
attribution, `dispatchState` describes whether delivery is established, and
`retrySafety` is separate from all of them. A familiar error *string* alone
does not prove the component that emitted it.

| Observation / example code | What can be said | What must not be inferred |
| --- | --- | --- |
| Trusted client observes `UPSTREAM_TOOL_REFUSAL_OBSERVED` before the Hub call | `upstream_client` observed a refusal; review the provider-visible response | MCP/Agent permission was granted, or the provider's private policy reason is known |
| Hub reports `MCP_TARGET_NOT_AUTHORIZED` | The selected target is outside the caller's authorized MCP scope | Retrying through a different tool or credential is an acceptable bypass |
| Agent connection reports `AGENT_OFFLINE` | Connectivity was lost or unavailable at the observed connection layer | Any previously dispatched mutation definitely did not run |
| Native Agent reports `SHELL_EXIT_NONZERO` | A command returned a nonzero exit code | The entire requested user task succeeded because MCP transport completed |
| Independent `task_verification` reports `TASK_VERIFICATION_FAILED` | A postcondition failed independently of transport and process status | A running PID or accepted command proves business-task completion |

**Error-origin decision matrix (concrete v2 inputs, not a live capture):**

| Observed event | `observedAt` / `dispatched` | `causeLayer` / `retrySafety` from `classifyFailure` | Safe user-facing action |
| --- | --- | --- | --- |
| Client refusal `UPSTREAM_TOOL_REFUSAL_OBSERVED` | `upstream_client` / `false` | `upstream_client` / `manual_review` | Stop; inspect the provider-visible refusal, never route around it |
| Lost Agent `AGENT_OFFLINE` | `device_connection` / `unknown` | `device_connection` / `reconcile_first` | Check device connectivity and original operation before any mutation retry |
| Hub target denial `MCP_TARGET_NOT_AUTHORIZED` | `mcp_hub` / `false` | `mcp_hub` / `after_reauthorization` | Choose only a permitted device or request scoped authorization |
| Agent local path denial `PATH_DENIED` | `native_agent` / `false` | `native_agent` / `after_reauthorization` | Ask the owner for an explicit path grant; never switch to shell to evade a denial |
| Uncertain dispatch `MUTATION_STATE_UNKNOWN` | `mcp_hub` / `unknown` | `undetermined` / `reconcile_first` | Query the original operation ID and read back the target; do not replay |

The same public error string with a different actual observer may remain
`undetermined`; the Hub cannot infer an unseen provider refusal. For a
possibly dispatched mutation, `retrySafety` stays `reconcile_first` even if
the visible error resembles an authorization or connectivity denial. These
exact cases are executed against the non-mutating error classifier by the
K08 decision-matrix regression test; the table does not change access policy.

For an unconfirmed mutation, first use the original operation ID and an
authorized read-only status/readback path such as `agent_operation_status` when
available; a missing operation record is **not** proof of no effect. This v1
tool's input requires a `request_id` UUID, not a guessed command name. Do not
invent an operation ID or auto-replay after a timeout. The `agent_operation_status`
schema and output profile are frozen in the v1 JSON contracts linked above.

**Successful status query is not successful mutation:** a normal
`agent_operation_status` MCP result may have `structuredContent.ok === true`
while `structuredContent.data.found === false`, or while the returned
`record.status` is `in_progress` or `unknown`. These are observation results,
not completion proof. The Agent metadata journal currently accepts the
`in_progress`/`succeeded`/`failed`/`unknown` status set; even a journal
`succeeded` record describes that recorded native operation, not necessarily
an independently verified *business* postcondition. A missing record is not
proof the original request had no effect. The broader `audit_query` filter's
`started`/`succeeded`/`failed` enum must not be substituted for the Agent
journal's four statuses.

**User-facing status wording:**

- **Running / queued:** an observed process or queue state, **not** completed work.
- **Outcome unknown:** evidence is missing or delivery/side effects are uncertain;
  reconcile before a new mutation.
- **Completed:** use only for an independently verified requested postcondition;
  transport success or a zero process exit code alone may be insufficient.

These are conservative support-language examples, not new runtime states or
permission grants. End-to-end provider refusal, live Agent and original-device
acceptance remain separate evidence gates for [#539](https://github.com/Naveax/Nexowire/issues/539).

## v1 compatibility rule

`src/mcp/surface.ts` contains `MCP_V1_STABLE_TOOLS`, the compatibility floor for v1.

For the lifetime of MCP surface v1:

- a stable tool name must not be removed;
- a stable tool name must not be renamed;
- required input fields must not be added incompatibly;
- accepted input semantics must not be narrowed without a migration path;
- successful structured output fields already relied upon by callers should not silently change meaning;
- additive optional fields and additive new tools are allowed.

The automated compatibility layer now has three levels:

- every stable v1 tool name must remain registered;
- `src/mcp/v1-input-contract.json` freezes the accepted input contract for every stable v1 tool and `test/mcp-schema-compat.test.ts` rejects provable narrowing;
- `src/mcp/v1-output-contract.json` freezes a machine-readable structured-output semantic profile for every stable v1 tool, including object shape expectations, stable semantic fields, native-vs-hub result profile, and image-vs-JSON content mode.

The input-schema checker permits compatible widening such as new optional fields, relaxed bounds, removed requirements, or additive enum values. It rejects removed fields, newly required fields, narrowed enum/type/bounds, newly restrictive patterns, and unreviewed combinator changes. This is intentionally conservative. Output semantic compatibility is now machine-readable at the stable-field/profile level. Tool-specific nested payload schemas can still evolve additively, so human-meaning changes and narrower nested semantics still require targeted review because software has not yet developed the decency to read maintainers' minds.

## Discovery

`nexowire_surface_info` returns:

- `mcpSurfaceVersion`
- `nativeAgentProtocolVersion`
- `stableToolCount`
- `outputContractVersion`
- `outputContractHash`
- optionally the stable v1 tool names
- optionally the full stable v1 structured-output contracts

The tool is hub-local and does not require a connected native agent. Normal credential tool allowlists still apply to its discovery/execution.

## Version changes

A breaking MCP change requires:

1. define a new surface version;
2. preserve the old surface or provide an explicit migration window;
3. document the changed tools and schemas;
4. add compatibility tests for both the retained and new surface where they coexist;
5. update `HANDOFF.md`, `ROADMAP.md`, and `PROJECT_STATE.json`.

Do not bump the surface version merely because a new additive capability is added.


## Frozen v1 input contract

Regenerate the frozen input contract only after deciding that a schema change is compatible with MCP surface v1:

```bash
npm run mcp:contract:generate
npm run typecheck
node --test --import tsx test/mcp-schema-compat.test.ts test/mcp-surface.test.ts
```

A changed snapshot is not evidence of compatibility by itself. Review the diff. If the change narrows previously accepted input, introduce a new surface version or a migration layer instead of updating the snapshot.

The input compatibility checker covers input JSON Schema; the separately frozen
output semantic profile described below covers selected structured-output
invariants. Neither automatically proves all nested output meanings unchanged.

## Frozen v1 output contract

The structured-output semantic contract is generated from `src/mcp/output-contract.ts` and frozen in `src/mcp/v1-output-contract.json`.

Regenerate only after explicit MCP v1 compatibility review:

```bash
npm run mcp:output-contract:generate
npm run typecheck
node --test --import tsx test/mcp-output-contract.test.ts test/mcp-surface.test.ts
```

Each stable tool advertises:

- whether it follows the normalized native-execution or hub-object result profile;
- that structured MCP metadata remains object-shaped;
- whether user-visible content is JSON text or image-plus-JSON;
- stable semantic fields and whether they are required on successful responses;
- invariant notes such as mutation-unknown replay behavior.

`nexowire_surface_info` exposes the output-contract version and canonical SHA-256. Clients can request the full contract with `include_output_contracts: true` when they need machine-readable compatibility metadata without loading repository files.
