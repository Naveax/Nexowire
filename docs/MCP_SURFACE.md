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

The compatibility checker currently covers input JSON Schema. Successful structured output stability is enforced through targeted tool tests and remains an explicit follow-up for a machine-readable output contract where the MCP SDK surface provides enough schema metadata.

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
