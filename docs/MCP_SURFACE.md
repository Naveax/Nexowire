# Nexowire MCP Surface Compatibility

Nexowire exposes a versioned ChatGPT-facing MCP surface independently from the native-agent wire protocol.

## Current versions

- MCP surface: **v1**
- Native-agent protocol: reported separately by `nexowire_surface_info`

These versions solve different compatibility problems. A native-agent protocol bump does not automatically require an MCP surface bump, and adding a new MCP tool does not automatically require either bump.

## v1 compatibility rule

`src/mcp/surface.ts` contains `MCP_V1_STABLE_TOOLS`, the compatibility floor for v1.

For the lifetime of MCP surface v1:

- a stable tool name must not be removed;
- a stable tool name must not be renamed;
- required input fields must not be added incompatibly;
- accepted input semantics must not be narrowed without a migration path;
- successful structured output fields already relied upon by callers should not silently change meaning;
- additive optional fields and additive new tools are allowed.

The automated compatibility test verifies that every stable v1 tool name remains registered. Schema/semantic compatibility still requires normal review and targeted tests because turning TypeScript into an oracle for human intent would be unusually ambitious, even by software standards.

## Discovery

`nexowire_surface_info` returns:

- `mcpSurfaceVersion`
- `nativeAgentProtocolVersion`
- `stableToolCount`
- optionally the stable v1 tool names

The tool is hub-local and does not require a connected native agent. Normal credential tool allowlists still apply to its discovery/execution.

## Version changes

A breaking MCP change requires:

1. define a new surface version;
2. preserve the old surface or provide an explicit migration window;
3. document the changed tools and schemas;
4. add compatibility tests for both the retained and new surface where they coexist;
5. update `HANDOFF.md`, `ROADMAP.md`, and `PROJECT_STATE.json`.

Do not bump the surface version merely because a new additive capability is added.
