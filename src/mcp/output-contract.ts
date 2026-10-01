import { createHash } from 'node:crypto';
import {
  MCP_SURFACE_VERSION,
  MCP_V1_STABLE_TOOLS,
  type McpV1StableTool,
} from './surface.js';
import { requiredCapabilityForMcpTool } from './tool-capabilities.js';

export const MCP_V1_OUTPUT_CONTRACT_VERSION = 1 as const;

export type McpOutputProfile =
  | 'native-execution-v1'
  | 'hub-object-v1';

export type McpOutputContentMode =
  | 'json-text'
  | 'image-plus-json';

export interface McpStableField {
  path: string;
  type:
    | 'any'
    | 'array'
    | 'boolean'
    | 'number'
    | 'object'
    | 'string'
    | 'string-or-null';
  meaning: string;
  requiredOnSuccess: boolean;
}

export interface McpV1OutputContract {
  tool: McpV1StableTool;
  surfaceVersion: 1;
  contractVersion: 1;
  profile: McpOutputProfile;
  structuredContentType: 'object';
  contentMode: McpOutputContentMode;
  fields: McpStableField[];
  semantics: string[];
}

const IMAGE_TOOLS = new Set<McpV1StableTool>([
  'browser_screenshot',
  'browser_visual_verify',
  'windows_screenshot',
]);

const HUB_REQUIRED_FIELDS: Readonly<
  Partial<Record<McpV1StableTool, readonly McpStableField[]>>
> = {
  audit_query: [
    {
      path: 'events',
      type: 'array',
      meaning: 'Bounded matching audit events.',
      requiredOnSuccess: true,
    },
  ],
  audit_recent: [
    {
      path: 'events',
      type: 'array',
      meaning: 'Recent payload-free audit events.',
      requiredOnSuccess: true,
    },
  ],
  device_alias_list: [
    {
      path: 'aliases',
      type: 'array',
      meaning: 'Visible persistent device aliases.',
      requiredOnSuccess: true,
    },
  ],
  device_alias_set: [
    {
      path: 'alias',
      type: 'object',
      meaning: 'Persisted alias record.',
      requiredOnSuccess: true,
    },
  ],
  device_group_list: [
    {
      path: 'groups',
      type: 'array',
      meaning: 'Visible persistent device groups.',
      requiredOnSuccess: true,
    },
  ],
  device_group_set: [
    {
      path: 'group',
      type: 'object',
      meaning: 'Persisted device-group record.',
      requiredOnSuccess: true,
    },
  ],
  device_route: [
    {
      path: 'selected',
      type: 'any',
      meaning:
        'Selected device route when exactly one candidate remains, otherwise null.',
      requiredOnSuccess: true,
    },
    {
      path: 'ambiguous',
      type: 'boolean',
      meaning: 'Whether more than one candidate remains.',
      requiredOnSuccess: true,
    },
    {
      path: 'candidates',
      type: 'array',
      meaning: 'Bounded candidate device routes.',
      requiredOnSuccess: true,
    },
  ],
  device_route_policy_list: [
    {
      path: 'policies',
      type: 'array',
      meaning: 'Visible deterministic routing policies.',
      requiredOnSuccess: true,
    },
  ],
  device_route_policy_resolve: [
    {
      path: 'policy',
      type: 'object',
      meaning: 'Resolved routing policy.',
      requiredOnSuccess: true,
    },
    {
      path: 'selected',
      type: 'any',
      meaning:
        'Selected device route or null when deterministic selection fails.',
      requiredOnSuccess: true,
    },
    {
      path: 'ambiguous',
      type: 'boolean',
      meaning: 'Whether policy resolution is ambiguous.',
      requiredOnSuccess: true,
    },
    {
      path: 'candidates',
      type: 'array',
      meaning: 'Current candidates evaluated by the policy.',
      requiredOnSuccess: true,
    },
    {
      path: 'reason',
      type: 'string',
      meaning: 'Deterministic selection reason.',
      requiredOnSuccess: true,
    },
  ],
  device_route_policy_set: [
    {
      path: 'policy',
      type: 'object',
      meaning: 'Persisted routing-policy record.',
      requiredOnSuccess: true,
    },
  ],
  devices_list: [
    {
      path: 'devices',
      type: 'array',
      meaning: 'Visible Nexowire device routing entries.',
      requiredOnSuccess: true,
    },
  ],
  events_read: [
    {
      path: 'events',
      type: 'array',
      meaning: 'Bounded event-feed entries after the requested cursor.',
      requiredOnSuccess: true,
    },
  ],
  nexowire_surface_info: [
    {
      path: 'mcpSurfaceVersion',
      type: 'number',
      meaning: 'ChatGPT-facing MCP compatibility surface version.',
      requiredOnSuccess: true,
    },
    {
      path: 'nativeAgentProtocolVersion',
      type: 'number',
      meaning: 'Independent native-agent wire protocol version.',
      requiredOnSuccess: true,
    },
    {
      path: 'stableToolCount',
      type: 'number',
      meaning: 'Number of tool names in the MCP v1 compatibility floor.',
      requiredOnSuccess: true,
    },
    {
      path: 'outputContractVersion',
      type: 'number',
      meaning: 'Machine-readable MCP v1 structured-output contract version.',
      requiredOnSuccess: true,
    },
    {
      path: 'outputContractHash',
      type: 'string',
      meaning:
        'SHA-256 of the canonical MCP v1 structured-output contract.',
      requiredOnSuccess: true,
    },
  ],
  operations_idempotency_list: [
    {
      path: 'records',
      type: 'array',
      meaning: 'Recent payload-free idempotency records.',
      requiredOnSuccess: true,
    },
  ],
  policy_device_bind: [
    {
      path: 'binding',
      type: 'object',
      meaning: 'Persisted device-policy binding.',
      requiredOnSuccess: true,
    },
  ],
  policy_device_check: [
    {
      path: 'allowed',
      type: 'boolean',
      meaning:
        'Whether the requested capability is allowed for the selected device.',
      requiredOnSuccess: true,
    },
  ],
  policy_profile_list: [
    {
      path: 'profiles',
      type: 'array',
      meaning: 'Persistent capability-policy profiles.',
      requiredOnSuccess: true,
    },
    {
      path: 'bindings',
      type: 'array',
      meaning: 'Persistent device-policy bindings.',
      requiredOnSuccess: true,
    },
  ],
  policy_profile_set: [
    {
      path: 'profile',
      type: 'object',
      meaning: 'Persisted capability-policy profile.',
      requiredOnSuccess: true,
    },
  ],
  skill_read: [
    {
      path: 'name',
      type: 'string',
      meaning: 'Loaded skill name.',
      requiredOnSuccess: true,
    },
    {
      path: 'manifest',
      type: 'object',
      meaning: 'Machine-readable skill manifest.',
      requiredOnSuccess: true,
    },
    {
      path: 'markdown',
      type: 'string',
      meaning: 'Skill workflow markdown.',
      requiredOnSuccess: true,
    },
  ],
  skills_list: [
    {
      path: 'skills',
      type: 'array',
      meaning: 'Machine-readable skill manifests/evaluations.',
      requiredOnSuccess: true,
    },
  ],
  workspace_checkpoint_get: [
    {
      path: 'checkpoint',
      type: 'any',
      meaning:
        'Latest checkpoint for the requested device/workspace or null when absent.',
      requiredOnSuccess: true,
    },
  ],
  workspace_checkpoint_list: [
    {
      path: 'checkpoints',
      type: 'array',
      meaning: 'Persisted resumable workspace checkpoints.',
      requiredOnSuccess: true,
    },
  ],
};

const NATIVE_FIELDS: readonly McpStableField[] = [
  {
    path: 'ok',
    type: 'boolean',
    meaning:
      'Whether native capability execution completed successfully.',
    requiredOnSuccess: true,
  },
  {
    path: 'data',
    type: 'any',
    meaning:
      'Capability-specific structured data when the capability returns data.',
    requiredOnSuccess: false,
  },
  {
    path: 'stdout',
    type: 'string',
    meaning: 'Bounded stdout when the capability exposes stdout.',
    requiredOnSuccess: false,
  },
  {
    path: 'stderr',
    type: 'string',
    meaning: 'Bounded stderr when the capability exposes stderr.',
    requiredOnSuccess: false,
  },
  {
    path: 'exitCode',
    type: 'any',
    meaning:
      'Process exit code or null when the capability exposes exit state.',
    requiredOnSuccess: false,
  },
  {
    path: 'truncated',
    type: 'boolean',
    meaning: 'Whether bounded textual output was truncated.',
    requiredOnSuccess: false,
  },
  {
    path: 'meta',
    type: 'object',
    meaning:
      'Provider/target/capability/timing provenance for normal native execution.',
    requiredOnSuccess: false,
  },
  {
    path: 'error',
    type: 'object',
    meaning:
      'Structured execution error with stable code/message semantics on native failures.',
    requiredOnSuccess: false,
  },
  {
    path: 'idempotency',
    type: 'object',
    meaning:
      'Replay/idempotency metadata when an explicit idempotency key is used.',
    requiredOnSuccess: false,
  },
];

function hubFields(tool: McpV1StableTool): McpStableField[] {
  return [...(HUB_REQUIRED_FIELDS[tool] ?? [])];
}

export function buildMcpV1OutputContracts(): Record<
  McpV1StableTool,
  McpV1OutputContract
> {
  const entries = MCP_V1_STABLE_TOOLS.map((tool) => {
    const native = requiredCapabilityForMcpTool(tool) !== undefined;
    const contract: McpV1OutputContract = {
      tool,
      surfaceVersion: MCP_SURFACE_VERSION,
      contractVersion: MCP_V1_OUTPUT_CONTRACT_VERSION,
      profile: native ? 'native-execution-v1' : 'hub-object-v1',
      structuredContentType: 'object',
      contentMode: IMAGE_TOOLS.has(tool)
        ? 'image-plus-json'
        : 'json-text',
      fields: native ? [...NATIVE_FIELDS] : hubFields(tool),
      semantics: native
        ? [
            'structuredContent is always an object',
            'ok=false represents execution failure and MCP isError is set',
            'normal provider execution may include meta provenance',
            'ambiguous mutation failure is not silently replayed',
            'tool-specific data remains bounded by the capability contract',
          ]
        : [
            'structuredContent is always an object',
            'toolResult error responses set MCP isError',
            'listed requiredOnSuccess fields are the v1 semantic floor',
          ],
    };
    return [tool, contract] as const;
  });

  return Object.fromEntries(entries) as Record<
    McpV1StableTool,
    McpV1OutputContract
  >;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(stableJson).join(',') + ']';
  }
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(object)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) + ':' + stableJson(object[key]),
        )
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

export function mcpV1OutputContractHash(
  contracts = buildMcpV1OutputContracts(),
): string {
  return createHash('sha256')
    .update(stableJson(contracts), 'utf8')
    .digest('hex');
}
