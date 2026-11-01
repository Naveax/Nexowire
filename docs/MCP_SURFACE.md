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
The matrix below is the intersection of those three sources at upstream `main`
`93b6df33ef58610dcfdf3584bfe774e5afa7df4d`. It is checked by
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
