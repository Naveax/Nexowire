import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { AuditLog } from '../audit/log.js';
import type { AgentBroker } from '../core/agent-broker.js';
import type { ProviderRegistry } from '../core/provider-registry.js';
import type { DeviceAliasStore } from '../devices/alias-store.js';
import type { DeviceDirectory } from '../devices/directory.js';
import type { DeviceGroupStore } from '../devices/group-store.js';
import type { DeviceRoutingPolicyStore } from '../devices/routing-policy-store.js';
import {
  buildDeviceRoutingEntries,
  filterDeviceRoutes,
  selectDeviceRoute,
  type DeviceRoutingEntry,
} from '../devices/routing.js';
import { idempotencyEligibility } from '../operations/idempotency-policy.js';
import {
  IdempotencyStoreError,
  operationFingerprint,
  type IdempotencyStore,
} from '../operations/idempotency-store.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { WorkspaceStore } from '../workspace/store.js';
import type { CapabilityPolicyStore } from '../security/capability-policy.js';
import type { CredentialStore } from '../security/credential-store.js';
import type { BearerAuthorization } from '../security/auth.js';
import { isMcpToolAuthorized } from '../security/tool-authorization.js';
import {
  authorizedRoutingPolicyNames,
  directlyAuthorizedDeviceIds,
  hasMcpTargetRestrictions,
  isRoutingPolicyAuthorized,
} from '../security/target-authorization.js';
import { isMcpToolAvailableForCapabilities } from './tool-capabilities.js';
import { AGENT_PROTOCOL_VERSION } from '../protocol/agent.js';
import {
  MCP_SURFACE_VERSION,
  MCP_V1_STABLE_TOOLS,
} from './surface.js';
import {
  MCP_V1_OUTPUT_CONTRACT_VERSION,
  buildMcpV1OutputContracts,
  mcpV1OutputContractHash,
} from './output-contract.js';

export interface McpContext {
  broker: AgentBroker;
  providers: ProviderRegistry;
  devices?: DeviceDirectory;
  aliases?: DeviceAliasStore;
  groups?: DeviceGroupStore;
  routingPolicies?: DeviceRoutingPolicyStore;
  idempotency?: IdempotencyStore;
  policies?: CapabilityPolicyStore;
  credentials?: CredentialStore;
  toolAuthorization?: BearerAuthorization;
  availableCapabilities?: readonly string[];
  audit?: AuditLog;
  workspaces: WorkspaceStore;
  skills: SkillRegistry;
}

function applyToolRegistrationFilters(
  server: McpServer,
  input: {
    authorization?: BearerAuthorization;
    availableCapabilities?: readonly string[];
  },
): void {
  const authorizationRestricted =
    input.authorization !== undefined &&
    input.authorization.kind !== 'static';
  const capabilityRestricted =
    input.availableCapabilities !== undefined;

  if (!authorizationRestricted && !capabilityRestricted) {
    return;
  }

  const availableCapabilities =
    input.availableCapabilities === undefined
      ? undefined
      : new Set(input.availableCapabilities);

  const originalRegisterTool = server.registerTool.bind(server);
  type RegisteredToolHandle = {
    disable(): void;
  };
  const untypedRegister = originalRegisterTool as unknown as (
    ...args: unknown[]
  ) => RegisteredToolHandle;

  server.registerTool = ((...args: unknown[]) => {
    const name = typeof args[0] === 'string' ? args[0] : '';
    const registered = untypedRegister(...args);
    if (!name) return registered;

    const authorized = isMcpToolAuthorized(
      input.authorization,
      name,
    );
    const capabilityAvailable =
      availableCapabilities === undefined ||
      isMcpToolAvailableForCapabilities(
        name,
        availableCapabilities,
      );

    if (!authorized || !capabilityAvailable) {
      registered.disable();
    }
    return registered;
  }) as typeof server.registerTool;
}

function toolResult(data: unknown, isError = false) {
  const structured =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { value: data };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}

async function allRoutingEntries(
  ctx: McpContext,
): Promise<DeviceRoutingEntry[]> {
  const [targets, records, aliasRecords] = await Promise.all([
    ctx.providers.listTargets(),
    ctx.devices ? ctx.devices.list() : Promise.resolve([]),
    ctx.aliases ? ctx.aliases.list() : Promise.resolve([]),
  ]);
  const aliasesByDevice = new Map<string, string[]>();
  for (const record of aliasRecords) {
    const current = aliasesByDevice.get(record.deviceId) ?? [];
    current.push(record.alias);
    aliasesByDevice.set(record.deviceId, current);
  }
  return buildDeviceRoutingEntries({
    records,
    targets,
    aliasesByDevice,
  });
}

async function routingPolicyTargetId(
  ctx: McpContext,
  devices: readonly DeviceRoutingEntry[],
  name: string,
): Promise<string | undefined> {
  const policy = await ctx.routingPolicies?.get(name);
  if (!policy) return undefined;

  let candidates = filterDeviceRoutes(devices, {
    ...(policy.platform ? { platform: policy.platform } : {}),
    ...(policy.nameContains
      ? { nameContains: policy.nameContains }
      : {}),
    ...(policy.requiredCapabilities.length > 0
      ? { requiredCapabilities: policy.requiredCapabilities }
      : {}),
    onlineOnly: policy.onlineOnly,
  });

  if (policy.group) {
    const group = await ctx.groups?.get(policy.group);
    if (!group) return undefined;
    const members = new Set(group.deviceIds);
    candidates = candidates.filter((device) =>
      members.has(device.id),
    );
  }

  return selectDeviceRoute(candidates, {
    selection: policy.selection,
    priorityDeviceIds: policy.priorityDeviceIds,
  }).selected?.id;
}

async function authorizedTargetIds(
  ctx: McpContext,
  devices: readonly DeviceRoutingEntry[],
): Promise<Set<string> | undefined> {
  if (!hasMcpTargetRestrictions(ctx.toolAuthorization)) {
    return undefined;
  }

  const allowed = new Set<string>(
    directlyAuthorizedDeviceIds(ctx.toolAuthorization),
  );
  for (const routeName of authorizedRoutingPolicyNames(
    ctx.toolAuthorization,
  )) {
    const selected = await routingPolicyTargetId(
      ctx,
      devices,
      routeName,
    );
    if (selected) allowed.add(selected);
  }
  return allowed;
}

async function routingEntries(
  ctx: McpContext,
): Promise<DeviceRoutingEntry[]> {
  const devices = await allRoutingEntries(ctx);
  const allowed = await authorizedTargetIds(ctx, devices);
  return allowed
    ? devices.filter((device) => allowed.has(device.id))
    : devices;
}

class McpTargetAuthorizationError extends Error {
  readonly code = 'MCP_TARGET_NOT_AUTHORIZED';

  constructor(message: string) {
    super(message);
    this.name = 'McpTargetAuthorizationError';
  }
}

async function resolveDevice(
  ctx: McpContext,
  requested?: string,
): Promise<string> {
  const devices = await routingEntries(ctx);
  const onlineIds = new Set(
    devices.filter((device) => device.online).map((device) => device.id),
  );

  if (requested) {
    if (onlineIds.has(requested)) return requested;

    const aliased = await ctx.aliases?.resolve(requested);
    if (aliased && onlineIds.has(aliased)) return aliased;

    throw new McpTargetAuthorizationError(
      'Requested Nexowire device is offline, unknown, or outside this credential scope.',
    );
  }

  const ids = [...onlineIds];
  if (ids.length === 1 && ids[0]) return ids[0];

  if (ids.length === 0) {
    throw new McpTargetAuthorizationError(
      hasMcpTargetRestrictions(ctx.toolAuthorization)
        ? 'No online Nexowire device is available inside this credential scope.'
        : 'No Nexowire devices are online.',
    );
  }

  throw new Error(
    'Multiple Nexowire devices are available; device_id or a device alias is required.',
  );
}

async function execute(
  ctx: McpContext,
  capability: string,
  input: unknown,
  deviceId?: string,
  providerId?: string,
  timeoutMs?: number,
  idempotencyKey?: string,
) {
  let operationId: string = randomUUID();
  const started = performance.now();
  let targetId: string | undefined;
  let idempotencyCreated = false;

  try {
    targetId = await resolveDevice(ctx, deviceId);
    await ctx.policies?.assertAllowed(targetId, capability);

    if (idempotencyKey) {
      if (!ctx.idempotency) {
        throw new IdempotencyStoreError(
          'IDEMPOTENCY_UNAVAILABLE',
          'Idempotency storage is unavailable in this Nexowire runtime.',
        );
      }

      const eligibility = idempotencyEligibility(capability, input);
      if (!eligibility.eligible) {
        throw new IdempotencyStoreError(
          'IDEMPOTENCY_UNSUPPORTED',
          eligibility.reason ??
            'This mutation is not eligible for idempotent execution.',
          { capability },
        );
      }

      const fingerprint = operationFingerprint({
        targetId,
        capability,
        ...(providerId ? { providerId } : {}),
        payload: input,
      });
      const begun = await ctx.idempotency.begin({
        key: idempotencyKey,
        fingerprint,
        capability,
        targetId,
      });
      operationId = begun.record.operationId;

      if (!begun.created) {
        if (
          begun.cachedResult &&
          typeof begun.cachedResult === 'object' &&
          !Array.isArray(begun.cachedResult) &&
          'ok' in begun.cachedResult &&
          typeof begun.cachedResult.ok === 'boolean'
        ) {
          const cached = begun.cachedResult as Record<string, unknown> & {
            ok: boolean;
          };
          return toolResult(
            {
              ...cached,
              idempotency: {
                key: begun.record.key,
                replayed: true,
                persistedStatus: begun.record.status,
                operationId: begun.record.operationId,
                resultSource: 'memory',
              },
            },
            !cached.ok,
          );
        }

        if (begun.record.status === 'succeeded') {
          return toolResult({
            ok: true,
            idempotency: {
              key: begun.record.key,
              replayed: true,
              persistedStatus: begun.record.status,
              operationId: begun.record.operationId,
              resultSource: 'record_only',
              resultUnavailableAfterRestart: true,
            },
          });
        }

        const code =
          begun.record.status === 'unknown'
            ? 'IDEMPOTENCY_STATE_UNKNOWN'
            : begun.record.status === 'in_progress'
              ? 'IDEMPOTENCY_IN_PROGRESS'
              : 'IDEMPOTENCY_PREVIOUS_FAILURE';
        return toolResult(
          {
            ok: false,
            error: {
              code,
              message:
                begun.record.status === 'unknown'
                  ? 'A previous attempt with this idempotency key has unknown final state. Verify target state before choosing a new key.'
                  : begun.record.status === 'in_progress'
                    ? 'An operation with this idempotency key is already in progress.'
                    : 'A previous attempt with this idempotency key failed and will not be replayed automatically.',
            },
            idempotency: {
              key: begun.record.key,
              replayed: true,
              persistedStatus: begun.record.status,
              operationId: begun.record.operationId,
            },
          },
          true,
        );
      }

      idempotencyCreated = true;
    }

    await ctx.audit?.write({
      operationId,
      status: 'started',
      capability,
      targetId,
      ...(providerId ? { providerId } : {}),
    });

    const result = await ctx.providers.execute(
      {
        targetId,
        capability,
        input,
        requestId: operationId,
        ...(timeoutMs ? { timeoutMs } : {}),
      },
      providerId,
    );

    if (idempotencyKey && idempotencyCreated && ctx.idempotency) {
      await ctx.idempotency.complete(
        idempotencyKey,
        result.ok ? 'succeeded' : 'failed',
        result,
      );
    }

    await ctx.audit?.write({
      operationId,
      status: result.ok ? 'succeeded' : 'failed',
      capability,
      targetId,
      providerId: result.meta.providerId,
      durationMs: Math.round(performance.now() - started),
      ...(result.error?.code ? { errorCode: result.error.code } : {}),
      ...(result.error?.message ? { message: result.error.message } : {}),
    });
    return toolResult(
      idempotencyKey
        ? {
            ...result,
            idempotency: {
              key: idempotencyKey,
              replayed: false,
              persistedStatus: result.ok ? 'succeeded' : 'failed',
              operationId,
            },
          }
        : result,
      !result.ok,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'EXECUTION_FAILED';

    if (idempotencyKey && idempotencyCreated && ctx.idempotency) {
      await ctx.idempotency.complete(
        idempotencyKey,
        errorCode === 'MUTATION_STATE_UNKNOWN' ? 'unknown' : 'failed',
      );
    }

    await ctx.audit?.write({
      operationId,
      status: 'failed',
      capability,
      ...(targetId ? { targetId } : {}),
      ...(providerId ? { providerId } : {}),
      durationMs: Math.round(performance.now() - started),
      errorCode,
      message,
    });
    return toolResult(
      {
        ok: false,
        operationId,
        error: {
          code: errorCode,
          message,
        },
        ...(idempotencyKey
          ? {
              idempotency: {
                key: idempotencyKey,
                replayed: false,
                persistedStatus:
                  errorCode === 'MUTATION_STATE_UNKNOWN'
                    ? 'unknown'
                    : 'failed',
              },
            }
          : {}),
      },
      true,
    );
  }
}

const targetFields = {
  device_id: z.string().min(1).max(128).optional(),
  provider_id: z.string().min(1).max(128).optional(),
};

const idempotencyField = {
  idempotency_key: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/)
    .optional(),
};

export function createNexowireMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: 'nexowire', version: '0.1.0-dev.1' },
    { capabilities: { logging: {} } },
  );
  applyToolRegistrationFilters(server, {
    ...(ctx.toolAuthorization
      ? { authorization: ctx.toolAuthorization }
      : {}),
    ...(ctx.availableCapabilities !== undefined
      ? { availableCapabilities: ctx.availableCapabilities }
      : {}),
  });

  server.registerTool(
    'nexowire_surface_info',
    {
      title: 'Nexowire MCP surface info',
      description:
        'Report the stable MCP compatibility surface version and native-agent protocol version. Optionally include the v1 stable tool-name floor.',
      inputSchema: {
        include_tools: z.boolean().optional(),
        include_output_contracts: z.boolean().optional(),
      },
    },
    async ({ include_tools, include_output_contracts }) => {
      const outputContracts = buildMcpV1OutputContracts();
      return toolResult({
        mcpSurfaceVersion: MCP_SURFACE_VERSION,
        nativeAgentProtocolVersion: AGENT_PROTOCOL_VERSION,
        stableToolCount: MCP_V1_STABLE_TOOLS.length,
        outputContractVersion: MCP_V1_OUTPUT_CONTRACT_VERSION,
        outputContractHash: mcpV1OutputContractHash(outputContracts),
        ...(include_tools
          ? { stableTools: [...MCP_V1_STABLE_TOOLS] }
          : {}),
        ...(include_output_contracts
          ? { outputContracts }
          : {}),
      });
    },
  );

  server.registerTool(
    'policy_profile_list',
    {
      title: 'List capability policy profiles',
      description:
        'List persistent per-device capability policy profiles. Deny patterns override allow patterns.',
      inputSchema: {},
    },
    async () =>
      toolResult({
        profiles: ctx.policies
          ? await ctx.policies.listProfiles()
          : [],
        bindings: ctx.policies
          ? await ctx.policies.listBindings()
          : [],
      }),
  );

  server.registerTool(
    'policy_profile_set',
    {
      title: 'Set capability policy profile',
      description:
        'Create or replace a persistent capability allow/deny profile. Patterns may be exact, prefix wildcards such as windows.*, or *.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        allow: z.array(z.string().min(1).max(128)).min(1).max(256),
        deny: z.array(z.string().min(1).max(128)).max(256).optional(),
      },
    },
    async ({ name, allow, deny }) => {
      if (!ctx.policies) {
        return toolResult(
          { ok: false, error: 'Capability policy storage is unavailable.' },
          true,
        );
      }
      return toolResult({
        profile: await ctx.policies.setProfile(name, {
          allow,
          ...(deny ? { deny } : {}),
        }),
      });
    },
  );

  server.registerTool(
    'policy_profile_delete',
    {
      title: 'Delete capability policy profile',
      description:
        'Delete one capability policy profile and remove any device bindings that reference it.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      },
    },
    async ({ name }) => {
      if (!ctx.policies) {
        return toolResult(
          { ok: false, error: 'Capability policy storage is unavailable.' },
          true,
        );
      }
      return toolResult(await ctx.policies.deleteProfile(name));
    },
  );

  server.registerTool(
    'policy_device_bind',
    {
      title: 'Bind device capability policy',
      description:
        'Bind one known Nexowire device ID or alias to a capability policy profile.',
      inputSchema: {
        device: z.string().min(1).max(128),
        profile: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      },
    },
    async ({ device, profile }) => {
      if (!ctx.policies) {
        return toolResult(
          { ok: false, error: 'Capability policy storage is unavailable.' },
          true,
        );
      }

      const routes = await routingEntries(ctx);
      let deviceId = device;
      if (!routes.some((entry) => entry.id === deviceId)) {
        deviceId = (await ctx.aliases?.resolve(device)) ?? device;
      }
      if (!routes.some((entry) => entry.id === deviceId)) {
        return toolResult(
          {
            ok: false,
            error: {
              code: 'POLICY_DEVICE_NOT_FOUND',
              message:
                'Capability policy bindings require a known Nexowire device ID or alias.',
              requested: device,
            },
          },
          true,
        );
      }

      return toolResult({
        binding: await ctx.policies.bind(deviceId, profile),
        ...(deviceId !== device
          ? { requestedAlias: device, resolvedDeviceId: deviceId }
          : {}),
      });
    },
  );

  server.registerTool(
    'policy_device_unbind',
    {
      title: 'Unbind device capability policy',
      description:
        'Remove a device capability policy binding. The device returns to the runtime default policy.',
      inputSchema: {
        device: z.string().min(1).max(128),
      },
    },
    async ({ device }) => {
      if (!ctx.policies) {
        return toolResult(
          { ok: false, error: 'Capability policy storage is unavailable.' },
          true,
        );
      }
      const routes = await routingEntries(ctx);
      const deviceId = (await ctx.aliases?.resolve(device)) ?? device;
      if (!routes.some((entry) => entry.id === deviceId)) {
        return toolResult(
          {
            ok: false,
            error: {
              code: 'MCP_TARGET_NOT_AUTHORIZED',
              message:
                'Requested Nexowire device is unknown or outside this credential scope.',
            },
          },
          true,
        );
      }
      return toolResult(await ctx.policies.unbind(deviceId));
    },
  );

  server.registerTool(
    'policy_device_check',
    {
      title: 'Check device capability policy',
      description:
        'Evaluate whether one capability would be allowed for a device without executing it.',
      inputSchema: {
        device: z.string().min(1).max(128),
        capability: z.string().min(1).max(128),
      },
    },
    async ({ device, capability }) => {
      if (!ctx.policies) {
        return toolResult({
          allowed: true,
          bound: false,
          policyStorage: false,
        });
      }
      const routes = await routingEntries(ctx);
      const deviceId = (await ctx.aliases?.resolve(device)) ?? device;
      if (!routes.some((entry) => entry.id === deviceId)) {
        return toolResult(
          {
            ok: false,
            error: {
              code: 'MCP_TARGET_NOT_AUTHORIZED',
              message:
                'Requested Nexowire device is unknown or outside this credential scope.',
            },
          },
          true,
        );
      }
      return toolResult({
        deviceId,
        capability,
        ...(await ctx.policies.decision(deviceId, capability)),
      });
    },
  );

  server.registerTool(
    'operations_idempotency_list',
    {
      title: 'List idempotency operation records',
      description:
        'List recent payload-free idempotency records. Records contain fingerprints and status only, never mutation input or output payloads.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ limit }) =>
      toolResult({
        records: ctx.idempotency
          ? await ctx.idempotency.list(limit ?? 100)
          : [],
      }),
  );

  server.registerTool(
    'devices_list',
    {
      title: 'List Nexowire devices',
      description:
        'List known Nexowire devices with online state, capabilities, aliases, last-seen metadata, and available first-party routes.',
      inputSchema: {
        online_only: z.boolean().optional(),
      },
    },
    async ({ online_only }) => {
      const devices = await routingEntries(ctx);
      return toolResult({
        devices:
          online_only === true
            ? devices.filter((device) => device.online)
            : devices,
      });
    },
  );

  server.registerTool(
    'device_route',
    {
      title: 'Resolve a Nexowire device route',
      description:
        'Filter known devices by exact ID/alias, platform, name/alias substring, and required capabilities. Returns a selected device only when exactly one candidate remains; ambiguity is reported rather than silently choosing a different computer.',
      inputSchema: {
        device_id: z.string().min(1).max(128).optional(),
        group: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
          .optional(),
        platform: z.string().min(1).max(64).optional(),
        name_contains: z.string().min(1).max(128).optional(),
        required_capabilities: z
          .array(z.string().min(1).max(128))
          .max(64)
          .optional(),
        online_only: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      group,
      platform,
      name_contains,
      required_capabilities,
      online_only,
    }) => {
      const devices = await routingEntries(ctx);
      let resolvedDeviceId = device_id;
      if (
        device_id &&
        !devices.some((device) => device.id === device_id)
      ) {
        resolvedDeviceId =
          (await ctx.aliases?.resolve(device_id)) ?? device_id;
      }

      const groupRecord = group
        ? await ctx.groups?.get(group)
        : undefined;
      if (group && !groupRecord) {
        return toolResult(
          {
            ok: false,
            error: {
              code: 'DEVICE_GROUP_NOT_FOUND',
              message: `Unknown Nexowire device group: ${group}`,
            },
          },
          true,
        );
      }

      let candidates = filterDeviceRoutes(devices, {
        ...(resolvedDeviceId
          ? { deviceId: resolvedDeviceId }
          : {}),
        ...(platform ? { platform } : {}),
        ...(name_contains ? { nameContains: name_contains } : {}),
        ...(required_capabilities
          ? { requiredCapabilities: required_capabilities }
          : {}),
        onlineOnly: online_only ?? true,
      });

      if (groupRecord) {
        const members = new Set(groupRecord.deviceIds);
        candidates = candidates.filter((device) => members.has(device.id));
      }

      return toolResult({
        selected:
          candidates.length === 1 ? candidates[0] : null,
        ambiguous: candidates.length > 1,
        candidates,
        ...(groupRecord
          ? {
              requestedGroup: groupRecord.name,
              groupDeviceIds: groupRecord.deviceIds.filter((deviceId) =>
                devices.some((device) => device.id === deviceId),
              ),
            }
          : {}),
        ...(device_id && resolvedDeviceId !== device_id
          ? {
              requestedAlias: device_id,
              resolvedDeviceId,
            }
          : {}),
      });
    },
  );

  server.registerTool(
    'device_route_policy_list',
    {
      title: 'List device routing policies',
      description:
        'List persistent deterministic multi-device routing policies.',
      inputSchema: {},
    },
    async () => {
      const policies = ctx.routingPolicies
        ? await ctx.routingPolicies.list()
        : [];
      if (!hasMcpTargetRestrictions(ctx.toolAuthorization)) {
        return toolResult({ policies });
      }

      const allowedNames = new Set(
        authorizedRoutingPolicyNames(ctx.toolAuthorization),
      );
      const visibleIds = new Set(
        (await routingEntries(ctx)).map((device) => device.id),
      );
      return toolResult({
        policies: policies
          .filter((policy) => allowedNames.has(policy.name))
          .map((policy) => ({
            ...policy,
            priorityDeviceIds: policy.priorityDeviceIds.filter(
              (deviceId) => visibleIds.has(deviceId),
            ),
          })),
      });
    },
  );

  server.registerTool(
    'device_route_policy_set',
    {
      title: 'Set device routing policy',
      description:
        'Create or replace a named routing policy. unique_only fails closed on multiple candidates; priority uses an explicit ordered stable-device list.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        selection: z.enum(['unique_only', 'priority']).optional(),
        group: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
          .optional(),
        platform: z.string().min(1).max(64).optional(),
        name_contains: z.string().min(1).max(128).optional(),
        required_capabilities: z
          .array(z.string().min(1).max(128))
          .max(64)
          .optional(),
        priority_devices: z
          .array(z.string().min(1).max(128))
          .max(256)
          .optional(),
        online_only: z.boolean().optional(),
      },
    },
    async ({
      name,
      selection,
      group,
      platform,
      name_contains,
      required_capabilities,
      priority_devices,
      online_only,
    }) => {
      if (!ctx.routingPolicies) {
        return toolResult(
          { ok: false, error: 'Routing policy storage is unavailable.' },
          true,
        );
      }

      if (
        !isRoutingPolicyAuthorized(ctx.toolAuthorization, name)
      ) {
        return toolResult(
          {
            ok: false,
            error: {
              code: 'MCP_ROUTE_NOT_AUTHORIZED',
              message:
                'Requested routing policy is outside this credential scope.',
            },
          },
          true,
        );
      }

      if (group && !(await ctx.groups?.get(group))) {
        return toolResult(
          {
            ok: false,
            error: {
              code: 'DEVICE_GROUP_NOT_FOUND',
              message: `Unknown Nexowire device group: ${group}`,
            },
          },
          true,
        );
      }

      const known = await routingEntries(ctx);
      const knownIds = new Set(known.map((device) => device.id));
      const resolvedPriority: string[] = [];
      const unknown: string[] = [];

      for (const requested of priority_devices ?? []) {
        if (knownIds.has(requested)) {
          resolvedPriority.push(requested);
          continue;
        }
        const aliased = await ctx.aliases?.resolve(requested);
        if (aliased && knownIds.has(aliased)) {
          resolvedPriority.push(aliased);
          continue;
        }
        unknown.push(requested);
      }

      if (unknown.length > 0) {
        return toolResult(
          {
            ok: false,
            error: {
              code: 'ROUTING_POLICY_UNKNOWN_TARGET',
              message:
                'One or more priority targets are not known Nexowire devices or aliases.',
              unknown,
            },
          },
          true,
        );
      }

      return toolResult({
        policy: await ctx.routingPolicies.set(name, {
          ...(selection ? { selection } : {}),
          ...(group ? { group } : {}),
          ...(platform ? { platform } : {}),
          ...(name_contains ? { nameContains: name_contains } : {}),
          ...(required_capabilities
            ? { requiredCapabilities: required_capabilities }
            : {}),
          ...(priority_devices
            ? { priorityDeviceIds: resolvedPriority }
            : {}),
          ...(online_only !== undefined ? { onlineOnly: online_only } : {}),
        }),
      });
    },
  );

  server.registerTool(
    'device_route_policy_delete',
    {
      title: 'Delete device routing policy',
      description: 'Delete one persistent named routing policy.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      },
    },
    async ({ name }) => {
      if (!ctx.routingPolicies) {
        return toolResult(
          { ok: false, error: 'Routing policy storage is unavailable.' },
          true,
        );
      }
      if (
        !isRoutingPolicyAuthorized(ctx.toolAuthorization, name)
      ) {
        return toolResult(
          {
            ok: false,
            error: {
              code: 'MCP_ROUTE_NOT_AUTHORIZED',
              message:
                'Requested routing policy is outside this credential scope.',
            },
          },
          true,
        );
      }
      return toolResult(await ctx.routingPolicies.delete(name));
    },
  );

  server.registerTool(
    'device_route_policy_resolve',
    {
      title: 'Resolve named device routing policy',
      description:
        'Resolve a deterministic named routing policy against current known/online devices. unique_only never guesses; priority selects only from its explicit ordered stable-device list.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      },
    },
    async ({ name }) => {
      if (!ctx.routingPolicies) {
        return toolResult(
          { ok: false, error: 'Routing policy storage is unavailable.' },
          true,
        );
      }

      if (
        !isRoutingPolicyAuthorized(ctx.toolAuthorization, name)
      ) {
        return toolResult(
          {
            ok: false,
            error: {
              code: 'MCP_ROUTE_NOT_AUTHORIZED',
              message:
                'Requested routing policy is outside this credential scope.',
            },
          },
          true,
        );
      }

      const policy = await ctx.routingPolicies.get(name);
      if (!policy) {
        return toolResult(
          {
            ok: false,
            error: {
              code: 'ROUTING_POLICY_NOT_FOUND',
              message: `Unknown Nexowire routing policy: ${name}`,
            },
          },
          true,
        );
      }

      const devices = await routingEntries(ctx);
      let candidates = filterDeviceRoutes(devices, {
        ...(policy.platform ? { platform: policy.platform } : {}),
        ...(policy.nameContains
          ? { nameContains: policy.nameContains }
          : {}),
        ...(policy.requiredCapabilities.length > 0
          ? { requiredCapabilities: policy.requiredCapabilities }
          : {}),
        onlineOnly: policy.onlineOnly,
      });

      let groupDeviceIds: string[] | undefined;
      if (policy.group) {
        const group = await ctx.groups?.get(policy.group);
        if (!group) {
          return toolResult(
            {
              ok: false,
              error: {
                code: 'ROUTING_POLICY_GROUP_MISSING',
                message:
                  'Routing policy references a device group that no longer exists.',
                policy: policy.name,
                group: policy.group,
              },
            },
            true,
          );
        }
        const visibleIds = new Set(
          devices.map((device) => device.id),
        );
        groupDeviceIds = group.deviceIds.filter((deviceId) =>
          visibleIds.has(deviceId),
        );
        const members = new Set(groupDeviceIds);
        candidates = candidates.filter((device) => members.has(device.id));
      }

      const selection = selectDeviceRoute(candidates, {
        selection: policy.selection,
        priorityDeviceIds: policy.priorityDeviceIds,
      });

      const visibleIds = new Set(
        devices.map((device) => device.id),
      );
      return toolResult({
        policy: hasMcpTargetRestrictions(ctx.toolAuthorization)
          ? {
              ...policy,
              priorityDeviceIds: policy.priorityDeviceIds.filter(
                (deviceId) => visibleIds.has(deviceId),
              ),
            }
          : policy,
        selected: selection.selected,
        ambiguous: selection.ambiguous,
        candidates,
        ...(groupDeviceIds ? { groupDeviceIds } : {}),
        reason: selection.reason,
      });
    },
  );

  server.registerTool(
    'device_group_list',
    {
      title: 'List device groups',
      description:
        'List persistent Nexowire device groups. Groups contain stable device IDs and can include currently offline known devices.',
      inputSchema: {},
    },
    async () => {
      const groups = ctx.groups ? await ctx.groups.list() : [];
      if (!hasMcpTargetRestrictions(ctx.toolAuthorization)) {
        return toolResult({ groups });
      }
      const visible = new Set(
        (await routingEntries(ctx)).map((device) => device.id),
      );
      return toolResult({
        groups: groups
          .map((group) => ({
            ...group,
            deviceIds: group.deviceIds.filter((deviceId) =>
              visible.has(deviceId),
            ),
          }))
          .filter((group) => group.deviceIds.length > 0),
      });
    },
  );

  server.registerTool(
    'device_group_set',
    {
      title: 'Set device group',
      description:
        'Create or replace a persistent device group from known device IDs or aliases. Unknown targets fail closed.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        devices: z
          .array(z.string().min(1).max(128))
          .min(1)
          .max(256),
      },
    },
    async ({ name, devices: requestedDevices }) => {
      if (!ctx.groups) {
        return toolResult(
          { ok: false, error: 'Device group storage is unavailable.' },
          true,
        );
      }

      const known = await routingEntries(ctx);
      const knownIds = new Set(known.map((device) => device.id));
      const resolved: string[] = [];
      const unknown: string[] = [];

      for (const requested of requestedDevices) {
        if (knownIds.has(requested)) {
          resolved.push(requested);
          continue;
        }
        const aliased = await ctx.aliases?.resolve(requested);
        if (aliased && knownIds.has(aliased)) {
          resolved.push(aliased);
          continue;
        }
        unknown.push(requested);
      }

      if (unknown.length > 0) {
        return toolResult(
          {
            ok: false,
            error: {
              code: 'DEVICE_GROUP_UNKNOWN_TARGET',
              message:
                'One or more group members are not known Nexowire devices or aliases.',
              unknown,
            },
          },
          true,
        );
      }

      return toolResult({
        group: await ctx.groups.set(name, resolved),
      });
    },
  );

  server.registerTool(
    'device_group_delete',
    {
      title: 'Delete device group',
      description: 'Delete one persistent Nexowire device group.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      },
    },
    async ({ name }) => {
      if (!ctx.groups) {
        return toolResult(
          { ok: false, error: 'Device group storage is unavailable.' },
          true,
        );
      }
      if (hasMcpTargetRestrictions(ctx.toolAuthorization)) {
        const group = await ctx.groups.get(name);
        const visibleIds = new Set(
          (await routingEntries(ctx)).map((device) => device.id),
        );
        if (
          group &&
          group.deviceIds.some((deviceId) => !visibleIds.has(deviceId))
        ) {
          return toolResult(
            {
              ok: false,
              error: {
                code: 'MCP_TARGET_NOT_AUTHORIZED',
                message:
                  'Requested device group contains targets outside this credential scope.',
              },
            },
            true,
          );
        }
      }
      return toolResult(await ctx.groups.delete(name));
    },
  );

  server.registerTool(
    'device_alias_list',
    {
      title: 'List device aliases',
      description:
        'List persistent Nexowire aliases that map human-friendly names to stable native device IDs.',
      inputSchema: {},
    },
    async () => {
      const aliases = ctx.aliases ? await ctx.aliases.list() : [];
      if (!hasMcpTargetRestrictions(ctx.toolAuthorization)) {
        return toolResult({ aliases });
      }
      const visible = new Set(
        (await routingEntries(ctx)).map((device) => device.id),
      );
      return toolResult({
        aliases: aliases.filter((alias) =>
          visible.has(alias.deviceId),
        ),
      });
    },
  );

  server.registerTool(
    'device_alias_set',
    {
      title: 'Set device alias',
      description:
        'Create or replace a persistent alias for one currently online Nexowire native device.',
      inputSchema: {
        alias: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        device_id: z.string().min(1).max(128),
      },
    },
    async ({ alias, device_id }) => {
      if (!ctx.aliases) {
        return toolResult(
          { ok: false, error: 'Device alias storage is unavailable.' },
          true,
        );
      }
      const targets = await routingEntries(ctx);
      if (!targets.some((target) => target.online && target.id === device_id)) {
        return toolResult(
          {
            ok: false,
            error: {
              code: 'MCP_TARGET_NOT_AUTHORIZED',
              message:
                'Cannot alias an offline, unknown, or out-of-scope device.',
            },
          },
          true,
        );
      }
      return toolResult({
        alias: await ctx.aliases.set(alias, device_id),
      });
    },
  );

  server.registerTool(
    'device_alias_delete',
    {
      title: 'Delete device alias',
      description: 'Delete one persistent Nexowire device alias.',
      inputSchema: {
        alias: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      },
    },
    async ({ alias }) => {
      if (!ctx.aliases) {
        return toolResult(
          { ok: false, error: 'Device alias storage is unavailable.' },
          true,
        );
      }
      if (hasMcpTargetRestrictions(ctx.toolAuthorization)) {
        const record = (await ctx.aliases.list()).find(
          (entry) => entry.alias === alias.toLowerCase(),
        );
        const visible = new Set(
          (await routingEntries(ctx)).map((device) => device.id),
        );
        if (record && !visible.has(record.deviceId)) {
          return toolResult(
            {
              ok: false,
              error: {
                code: 'MCP_TARGET_NOT_AUTHORIZED',
                message:
                  'Requested alias belongs to a device outside this credential scope.',
              },
            },
            true,
          );
        }
      }
      return toolResult(await ctx.aliases.delete(alias));
    },
  );

  server.registerTool(
    'events_read',
    {
      title: 'Read Nexowire events',
      description:
        'Read bounded agent/process events by cursor. Supports topic/device filters and long-poll waits up to 10 seconds so clients can avoid tight polling loops.',
      inputSchema: {
        device_id: z.string().min(1).max(128).optional(),
        topics: z.array(z.string().min(1).max(128)).min(1).max(32).optional(),
        after_seq: z.number().int().min(0).optional(),
        max_events: z.number().int().min(1).max(1000).optional(),
        wait_ms: z.number().int().min(0).max(10_000).optional(),
      },
    },
    async ({ device_id, topics, after_seq, max_events, wait_ms }) =>
      toolResult(
        await ctx.broker.readEvents({
          ...(device_id ? { deviceId: device_id } : {}),
          ...(topics ? { topics } : {}),
          ...(after_seq !== undefined ? { afterSeq: after_seq } : {}),
          ...(max_events !== undefined ? { maxEvents: max_events } : {}),
          ...(wait_ms !== undefined ? { waitMs: wait_ms } : {}),
        }),
      ),
  );

  const postconditionBase = {
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  };

  const postconditionAssertionSchema = z.discriminatedUnion('kind', [
    z.object({
      ...postconditionBase,
      kind: z.literal('file.exists'),
      path: z.string().min(1).max(4096),
      expected: z.boolean().optional(),
    }),
    z.object({
      ...postconditionBase,
      kind: z.literal('file.sha256'),
      path: z.string().min(1).max(4096),
      expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
      max_bytes: z
        .number()
        .int()
        .min(1)
        .max(268_435_456)
        .optional(),
    }),
    z.object({
      ...postconditionBase,
      kind: z.literal('file.text_contains'),
      path: z.string().min(1).max(4096),
      needle: z.string().min(1).max(16_384),
      expected: z.boolean().optional(),
      max_bytes: z
        .number()
        .int()
        .min(1)
        .max(16_777_216)
        .optional(),
    }),
    z.object({
      ...postconditionBase,
      kind: z.literal('process.pid_alive'),
      pid: z.number().int().positive(),
      expected: z.boolean().optional(),
    }),
    z.object({
      ...postconditionBase,
      kind: z.literal('tcp.open'),
      host: z.string().min(1).max(255),
      port: z.number().int().min(1).max(65_535),
      expected: z.boolean().optional(),
      timeout_ms: z.number().int().min(100).max(30_000).optional(),
    }),
    z.object({
      ...postconditionBase,
      kind: z.literal('http.status'),
      url: z.string().url().max(4096),
      expected_status: z
        .array(z.number().int().min(100).max(599))
        .min(1)
        .max(32),
      timeout_ms: z.number().int().min(100).max(30_000).optional(),
    }),
  ]);

  server.registerTool(
    'verify_assertions',
    {
      title: 'Verify postconditions',
      description:
        'Run bounded read-only postcondition assertions over files, process liveness, TCP endpoints, and HTTP status without echoing matched secret text.',
      inputSchema: {
        ...targetFields,
        assertions: z
          .array(postconditionAssertionSchema)
          .min(1)
          .max(32),
        max_parallel: z.number().int().min(1).max(8).optional(),
        stop_on_failure: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      assertions,
      max_parallel,
      stop_on_failure,
    }) =>
      await execute(
        ctx,
        'verify.assertions',
        {
          assertions,
          ...(max_parallel !== undefined ? { max_parallel } : {}),
          ...(stop_on_failure !== undefined
            ? { stop_on_failure }
            : {}),
        },
        device_id,
        provider_id,
        60_000,
      ),
  );

  server.registerTool(
    'browser_session_start',
    {
      title: 'Start Nexowire browser session',
      description:
        'Start an isolated first-party Edge/Chrome session on the target device with loopback-only DevTools control.',
      inputSchema: {
        ...targetFields,
        browser: z.enum(['auto', 'edge', 'chrome']).optional(),
        headless: z.boolean().optional(),
        initial_url: z.string().min(1).max(4096).optional(),
        width: z.number().int().min(320).max(3840).optional(),
        height: z.number().int().min(240).max(2160).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      browser,
      headless,
      initial_url,
      width,
      height,
    }) =>
      await execute(
        ctx,
        'browser.session.start',
        {
          ...(browser ? { browser } : {}),
          ...(headless !== undefined ? { headless } : {}),
          ...(initial_url ? { initial_url } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
        },
        device_id,
        provider_id,
        60_000,
      ),
  );

  server.registerTool(
    'browser_session_list',
    {
      title: 'List Nexowire browser sessions',
      description:
        'List first-party browser sessions currently owned by the target Nexowire native agent.',
      inputSchema: targetFields,
    },
    async ({ device_id, provider_id }) =>
      await execute(
        ctx,
        'browser.session.list',
        {},
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'browser_session_stop',
    {
      title: 'Stop Nexowire browser session',
      description:
        'Stop one isolated browser session and remove its temporary browser profile when possible.',
      inputSchema: {
        ...targetFields,
        session_id: z.string().uuid(),
      },
    },
    async ({ device_id, provider_id, session_id }) =>
      await execute(
        ctx,
        'browser.session.stop',
        { session_id },
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'browser_tabs',
    {
      title: 'List browser tabs',
      description:
        'List page targets inside one Nexowire-owned browser session.',
      inputSchema: {
        ...targetFields,
        session_id: z.string().uuid(),
      },
    },
    async ({ device_id, provider_id, session_id }) =>
      await execute(
        ctx,
        'browser.tabs',
        { session_id },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'browser_navigate',
    {
      title: 'Navigate browser tab',
      description:
        'Navigate a Nexowire-owned browser page to an HTTP(S) URL or about:blank and wait for document readiness.',
      inputSchema: {
        ...targetFields,
        session_id: z.string().uuid(),
        target_id: z.string().min(1).max(256).optional(),
        url: z.string().min(1).max(4096),
        timeout_ms: z.number().int().min(1_000).max(60_000).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      session_id,
      target_id,
      url,
      timeout_ms,
    }) =>
      await execute(
        ctx,
        'browser.navigate',
        {
          session_id,
          ...(target_id ? { target_id } : {}),
          url,
          ...(timeout_ms !== undefined ? { timeout_ms } : {}),
        },
        device_id,
        provider_id,
        timeout_ms ? timeout_ms + 10_000 : 45_000,
      ),
  );

  server.registerTool(
    'browser_snapshot',
    {
      title: 'Inspect browser page',
      description:
        'Read a bounded structured snapshot of page text and interactive DOM elements with stable response-local CSS selectors. Password input values are suppressed.',
      inputSchema: {
        ...targetFields,
        session_id: z.string().uuid(),
        target_id: z.string().min(1).max(256).optional(),
        max_elements: z.number().int().min(1).max(1000).optional(),
        max_text_chars: z.number().int().min(1).max(100_000).optional(),
        max_element_text_chars: z.number().int().min(1).max(4096).optional(),
        include_hidden: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      session_id,
      target_id,
      max_elements,
      max_text_chars,
      max_element_text_chars,
      include_hidden,
    }) =>
      await execute(
        ctx,
        'browser.snapshot',
        {
          session_id,
          ...(target_id ? { target_id } : {}),
          ...(max_elements !== undefined ? { max_elements } : {}),
          ...(max_text_chars !== undefined ? { max_text_chars } : {}),
          ...(max_element_text_chars !== undefined
            ? { max_element_text_chars }
            : {}),
          ...(include_hidden !== undefined ? { include_hidden } : {}),
        },
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'browser_click',
    {
      title: 'Click exact browser element',
      description:
        'Click exactly one CSS-selected browser element. Zero, multiple, hidden, disabled, or zero-sized matches fail before input.',
      inputSchema: {
        ...targetFields,
        session_id: z.string().uuid(),
        target_id: z.string().min(1).max(256).optional(),
        selector: z.string().min(1).max(4096),
        button: z.enum(['left', 'right', 'middle']).optional(),
        click_count: z.number().int().min(1).max(3).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      session_id,
      target_id,
      selector,
      button,
      click_count,
    }) =>
      await execute(
        ctx,
        'browser.click',
        {
          session_id,
          ...(target_id ? { target_id } : {}),
          selector,
          ...(button ? { button } : {}),
          ...(click_count !== undefined ? { click_count } : {}),
        },
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'browser_set_value',
    {
      title: 'Set browser element value',
      description:
        'Set and verify the value of exactly one input, textarea, select, or contenteditable element. Submitted values are returned only as length/hash metadata.',
      inputSchema: {
        ...targetFields,
        session_id: z.string().uuid(),
        target_id: z.string().min(1).max(256).optional(),
        selector: z.string().min(1).max(4096),
        value: z.string().max(20_000),
      },
    },
    async ({
      device_id,
      provider_id,
      session_id,
      target_id,
      selector,
      value,
    }) =>
      await execute(
        ctx,
        'browser.set_value',
        {
          session_id,
          ...(target_id ? { target_id } : {}),
          selector,
          value,
        },
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'browser_visual_verify',
    {
      title: 'Visually verify browser element',
      description:
        'Isolate exactly one CSS-selected element, verify bounded DOM-backed expectations and hit-target visibility, and return a tightly cropped PNG for model-level visual inspection.',
      inputSchema: {
        ...targetFields,
        session_id: z.string().uuid(),
        target_id: z.string().min(1).max(256).optional(),
        selector: z.string().min(1).max(4096),
        expected_text: z.string().max(4096).optional(),
        text_mode: z.enum(['contains', 'exact']).optional(),
        expected_visible: z.boolean().optional(),
        expected_enabled: z.boolean().optional(),
        expected_checked: z.boolean().optional(),
        padding: z.number().int().min(0).max(200).optional(),
        max_bytes: z
          .number()
          .int()
          .min(65_536)
          .max(8_388_608)
          .optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      session_id,
      target_id,
      selector,
      expected_text,
      text_mode,
      expected_visible,
      expected_enabled,
      expected_checked,
      padding,
      max_bytes,
    }) => {
      const response = await execute(
        ctx,
        'browser.visual.verify',
        {
          session_id,
          ...(target_id ? { target_id } : {}),
          selector,
          ...(expected_text !== undefined ? { expected_text } : {}),
          ...(text_mode ? { text_mode } : {}),
          ...(expected_visible !== undefined
            ? { expected_visible }
            : {}),
          ...(expected_enabled !== undefined
            ? { expected_enabled }
            : {}),
          ...(expected_checked !== undefined
            ? { expected_checked }
            : {}),
          ...(padding !== undefined ? { padding } : {}),
          ...(max_bytes !== undefined ? { max_bytes } : {}),
        },
        device_id,
        provider_id,
        60_000,
      );

      if ('isError' in response && response.isError) return response;

      const structured = response.structuredContent as Record<string, unknown>;
      const data =
        typeof structured.data === 'object' &&
        structured.data !== null &&
        !Array.isArray(structured.data)
          ? (structured.data as Record<string, unknown>)
          : undefined;
      const screenshot =
        typeof data?.screenshot === 'object' &&
        data.screenshot !== null &&
        !Array.isArray(data.screenshot)
          ? (data.screenshot as Record<string, unknown>)
          : undefined;
      const base64 = screenshot?.base64;
      const mimeType = screenshot?.mimeType;

      if (
        !data ||
        !screenshot ||
        typeof base64 !== 'string' ||
        typeof mimeType !== 'string'
      ) {
        return toolResult(
          {
            ok: false,
            error:
              'Browser visual verification returned no inline image payload.',
          },
          true,
        );
      }

      const { base64: _base64, ...screenshotMetadata } = screenshot;
      const sanitized = {
        ...structured,
        data: {
          ...data,
          screenshot: screenshotMetadata,
        },
      };

      return {
        content: [
          {
            type: 'image' as const,
            data: base64,
            mimeType,
          },
          {
            type: 'text' as const,
            text: JSON.stringify(sanitized, null, 2),
          },
        ],
        structuredContent: sanitized,
      };
    },
  );

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Capture browser page screenshot',
      description:
        'Capture the current browser viewport as a bounded PNG and return it as MCP image content with compact metadata.',
      inputSchema: {
        ...targetFields,
        session_id: z.string().uuid(),
        target_id: z.string().min(1).max(256).optional(),
        max_bytes: z
          .number()
          .int()
          .min(65_536)
          .max(8_388_608)
          .optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      session_id,
      target_id,
      max_bytes,
    }) => {
      const response = await execute(
        ctx,
        'browser.screenshot',
        {
          session_id,
          ...(target_id ? { target_id } : {}),
          ...(max_bytes !== undefined ? { max_bytes } : {}),
        },
        device_id,
        provider_id,
        60_000,
      );

      if ('isError' in response && response.isError) return response;

      const structured = response.structuredContent as Record<string, unknown>;
      const screenshot =
        typeof structured.data === 'object' &&
        structured.data !== null &&
        !Array.isArray(structured.data)
          ? (structured.data as Record<string, unknown>)
          : undefined;
      const base64 = screenshot?.base64;
      const mimeType = screenshot?.mimeType;

      if (
        !screenshot ||
        typeof base64 !== 'string' ||
        typeof mimeType !== 'string'
      ) {
        return toolResult(
          {
            ok: false,
            error: 'Browser screenshot returned no inline image payload.',
          },
          true,
        );
      }

      const { base64: _base64, ...metadata } = screenshot;
      const sanitized = {
        ...structured,
        data: metadata,
      };

      return {
        content: [
          {
            type: 'image' as const,
            data: base64,
            mimeType,
          },
          {
            type: 'text' as const,
            text: JSON.stringify(sanitized, null, 2),
          },
        ],
        structuredContent: sanitized,
      };
    },
  );

  server.registerTool(
    'machine_snapshot',
    {
      title: 'Machine snapshot',
      description: 'Get a compact structured snapshot of a target computer.',
      inputSchema: targetFields,
    },
    async ({ device_id, provider_id }) =>
      await execute(ctx, 'machine.snapshot', {}, device_id, provider_id),
  );



  server.registerTool(
    'machine_health',
    {
      title: 'Machine health',
      description:
        'Get a compact sampled CPU, memory, uptime, and home-filesystem health snapshot from a target computer.',
      inputSchema: {
        ...targetFields,
        sample_ms: z.number().int().min(100).max(2_000).optional(),
      },
    },
    async ({ device_id, provider_id, sample_ms }) =>
      await execute(
        ctx,
        'machine.health',
        {
          ...(sample_ms !== undefined ? { sample_ms } : {}),
        },
        device_id,
        provider_id,
        sample_ms ? sample_ms + 10_000 : undefined,
      ),
  );

  server.registerTool(
    'network_dns_resolve',
    {
      title: 'Resolve DNS',
      description:
        'Resolve a hostname on the target computer and return structured address records plus lookup timing.',
      inputSchema: {
        ...targetFields,
        host: z.string().min(1).max(253),
        family: z.enum(['any', 'ipv4', 'ipv6']).optional(),
      },
    },
    async ({ device_id, provider_id, host, family }) =>
      await execute(
        ctx,
        'network.dns.resolve',
        {
          host,
          ...(family ? { family } : {}),
        },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'network_tcp_probe',
    {
      title: 'Probe TCP endpoint',
      description:
        'Test TCP reachability from the target computer with bounded timeout and structured local/remote socket metadata.',
      inputSchema: {
        ...targetFields,
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65_535),
        family: z.enum(['any', 'ipv4', 'ipv6']).optional(),
        timeout_ms: z.number().int().min(100).max(30_000).optional(),
      },
    },
    async ({ device_id, provider_id, host, port, family, timeout_ms }) =>
      await execute(
        ctx,
        'network.tcp.probe',
        {
          host,
          port,
          ...(family ? { family } : {}),
          ...(timeout_ms !== undefined ? { timeout_ms } : {}),
        },
        device_id,
        provider_id,
        timeout_ms ? timeout_ms + 5_000 : undefined,
      ),
  );

  server.registerTool(
    'network_http_probe',
    {
      title: 'Probe HTTP endpoint',
      description:
        'Probe an HTTP(S) URL from the target computer with bounded timeout, optional redirect following, and an optional bounded GET body preview.',
      inputSchema: {
        ...targetFields,
        url: z.string().url().max(8_192),
        method: z.enum(['HEAD', 'GET']).optional(),
        timeout_ms: z.number().int().min(100).max(30_000).optional(),
        follow_redirects: z.boolean().optional(),
        max_body_bytes: z.number().int().min(0).max(1_048_576).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      url,
      method,
      timeout_ms,
      follow_redirects,
      max_body_bytes,
    }) =>
      await execute(
        ctx,
        'network.http.probe',
        {
          url,
          ...(method ? { method } : {}),
          ...(timeout_ms !== undefined ? { timeout_ms } : {}),
          ...(follow_redirects !== undefined ? { follow_redirects } : {}),
          ...(max_body_bytes !== undefined ? { max_body_bytes } : {}),
        },
        device_id,
        provider_id,
        timeout_ms ? timeout_ms + 5_000 : undefined,
      ),
  );


  server.registerTool(
    'windows_window_list',
    {
      title: 'List Windows top-level windows',
      description:
        'Enumerate top-level Windows HWNDs with title, process metadata, visibility, minimized/foreground state, and screen rectangle.',
      inputSchema: {
        ...targetFields,
        include_hidden: z.boolean().optional(),
        title_contains: z.string().max(1024).optional(),
        process_id: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(2000).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      include_hidden,
      title_contains,
      process_id,
      limit,
    }) =>
      await execute(
        ctx,
        'windows.window.list',
        {
          ...(include_hidden !== undefined ? { include_hidden } : {}),
          ...(title_contains !== undefined ? { title_contains } : {}),
          ...(process_id !== undefined ? { process_id } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'windows_window_focus',
    {
      title: 'Focus exact Windows window',
      description:
        'Bring one exact HWND to the foreground, optionally restoring it first when minimized, and verify the final foreground HWND.',
      inputSchema: {
        ...targetFields,
        hwnd: z
          .string()
          .min(1)
          .max(32)
          .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
        restore_if_minimized: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      hwnd,
      restore_if_minimized,
    }) =>
      await execute(
        ctx,
        'windows.window.focus',
        {
          hwnd,
          ...(restore_if_minimized !== undefined
            ? { restore_if_minimized }
            : {}),
        },
        device_id,
        provider_id,
        45_000,
      ),
  );


  server.registerTool(
    'windows_screenshot',
    {
      title: 'Capture Windows screenshot',
      description:
        'Capture the visible virtual desktop, primary screen, or exact window rectangle as a bounded PNG image. Window mode captures current on-screen pixels and does not focus or rearrange the window.',
      inputSchema: {
        ...targetFields,
        source: z
          .enum(['virtual_desktop', 'primary_screen', 'window'])
          .optional(),
        hwnd: z
          .string()
          .min(1)
          .max(32)
          .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/)
          .optional(),
        max_width: z.number().int().min(160).max(7680).optional(),
        max_height: z.number().int().min(120).max(4320).optional(),
        max_bytes: z
          .number()
          .int()
          .min(65_536)
          .max(8_388_608)
          .optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      source,
      hwnd,
      max_width,
      max_height,
      max_bytes,
    }) => {
      const response = await execute(
        ctx,
        'windows.screenshot',
        {
          ...(source ? { source } : {}),
          ...(hwnd ? { hwnd } : {}),
          ...(max_width !== undefined ? { max_width } : {}),
          ...(max_height !== undefined ? { max_height } : {}),
          ...(max_bytes !== undefined ? { max_bytes } : {}),
        },
        device_id,
        provider_id,
        60_000,
      );

      if ('isError' in response && response.isError) return response;

      const structured = response.structuredContent as Record<string, unknown>;
      const screenshot =
        typeof structured.data === 'object' &&
        structured.data !== null &&
        !Array.isArray(structured.data)
          ? (structured.data as Record<string, unknown>)
          : undefined;
      const base64 = screenshot?.base64;
      const mimeType = screenshot?.mimeType;

      if (
        !screenshot ||
        typeof base64 !== 'string' ||
        typeof mimeType !== 'string'
      ) {
        return toolResult(
          {
            ok: false,
            error:
              'Screenshot provider returned no inline image payload.',
          },
          true,
        );
      }

      const { base64: _base64, ...metadata } = screenshot;
      const sanitized = {
        ...structured,
        data: metadata,
      };

      return {
        content: [
          {
            type: 'image' as const,
            data: base64,
            mimeType,
          },
          {
            type: 'text' as const,
            text: JSON.stringify(sanitized, null, 2),
          },
        ],
        structuredContent: sanitized,
      };
    },
  );


  server.registerTool(
    'windows_clipboard_read',
    {
      title: 'Read Windows clipboard text',
      description:
        'Read bounded Unicode text from the Windows clipboard. The result includes length, truncation, and SHA-256 metadata.',
      inputSchema: {
        ...targetFields,
        max_chars: z.number().int().min(1).max(100_000).optional(),
      },
    },
    async ({ device_id, provider_id, max_chars }) =>
      await execute(
        ctx,
        'windows.clipboard.read',
        {
          ...(max_chars !== undefined ? { max_chars } : {}),
        },
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'windows_clipboard_write',
    {
      title: 'Write Windows clipboard text',
      description:
        'Replace the Windows clipboard with exact Unicode text and verify the stored value.',
      inputSchema: {
        ...targetFields,
        text: z.string().min(1).max(100_000),
      },
    },
    async ({ device_id, provider_id, text }) =>
      await execute(
        ctx,
        'windows.clipboard.write',
        { text },
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'windows_clipboard_clear',
    {
      title: 'Clear Windows clipboard',
      description:
        'Clear clipboard contents and verify that Unicode text is no longer available.',
      inputSchema: {
        ...targetFields,
      },
    },
    async ({ device_id, provider_id }) =>
      await execute(
        ctx,
        'windows.clipboard.clear',
        {},
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'windows_keyboard_type',
    {
      title: 'Type Unicode text into exact foreground HWND',
      description:
        'Inject Unicode keyboard text only when the supplied HWND is already the current foreground window. Nexowire refuses to retarget input implicitly.',
      inputSchema: {
        ...targetFields,
        hwnd: z
          .string()
          .min(1)
          .max(32)
          .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
        text: z.string().min(1).max(20_000),
        interval_ms: z.number().int().min(0).max(100).optional(),
      },
    },
    async ({ device_id, provider_id, hwnd, text, interval_ms }) =>
      await execute(
        ctx,
        'windows.keyboard.type',
        {
          hwnd,
          text,
          ...(interval_ms !== undefined ? { interval_ms } : {}),
        },
        device_id,
        provider_id,
        Math.max(
          45_000,
          text.length * (interval_ms ?? 0) + 15_000,
        ),
      ),
  );

  server.registerTool(
    'windows_keyboard_hotkey',
    {
      title: 'Send hotkey to exact foreground HWND',
      description:
        'Send a bounded keyboard chord only when the supplied HWND is already foreground. Supports modifiers, navigation keys, A-Z, 0-9, and F1-F24.',
      inputSchema: {
        ...targetFields,
        hwnd: z
          .string()
          .min(1)
          .max(32)
          .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
        keys: z.array(z.string().min(1).max(32)).min(1).max(8),
      },
    },
    async ({ device_id, provider_id, hwnd, keys }) =>
      await execute(
        ctx,
        'windows.keyboard.hotkey',
        { hwnd, keys },
        device_id,
        provider_id,
        45_000,
      ),
  );


  server.registerTool(
    'windows_accessibility_tree',
    {
      title: 'Inspect Windows accessibility tree',
      description:
        'Inspect a bounded UI Automation tree for one exact HWND. Returns names, automation IDs, control types, bounds, states, supported patterns, and optional non-password ValuePattern text.',
      inputSchema: {
        ...targetFields,
        hwnd: z
          .string()
          .min(1)
          .max(32)
          .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
        max_depth: z.number().int().min(0).max(16).optional(),
        max_nodes: z.number().int().min(1).max(2000).optional(),
        include_offscreen: z.boolean().optional(),
        include_values: z.boolean().optional(),
        max_value_chars: z.number().int().min(1).max(8192).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      hwnd,
      max_depth,
      max_nodes,
      include_offscreen,
      include_values,
      max_value_chars,
    }) =>
      await execute(
        ctx,
        'windows.accessibility.tree',
        {
          hwnd,
          ...(max_depth !== undefined ? { max_depth } : {}),
          ...(max_nodes !== undefined ? { max_nodes } : {}),
          ...(include_offscreen !== undefined
            ? { include_offscreen }
            : {}),
          ...(include_values !== undefined ? { include_values } : {}),
          ...(max_value_chars !== undefined
            ? { max_value_chars }
            : {}),
        },
        device_id,
        provider_id,
        60_000,
      ),
  );

  server.registerTool(
    'windows_accessibility_find',
    {
      title: 'Find Windows accessibility elements',
      description:
        'Search one HWND accessibility tree by name fragment, exact automation ID, class name, or control type. At least one selector is required.',
      inputSchema: {
        ...targetFields,
        hwnd: z
          .string()
          .min(1)
          .max(32)
          .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
        name_contains: z.string().min(1).max(1024).optional(),
        automation_id: z.string().min(1).max(1024).optional(),
        class_name: z.string().min(1).max(1024).optional(),
        control_type: z.string().min(1).max(128).optional(),
        max_results: z.number().int().min(1).max(100).optional(),
        include_offscreen: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      hwnd,
      name_contains,
      automation_id,
      class_name,
      control_type,
      max_results,
      include_offscreen,
    }) =>
      await execute(
        ctx,
        'windows.accessibility.find',
        {
          hwnd,
          ...(name_contains !== undefined ? { name_contains } : {}),
          ...(automation_id !== undefined ? { automation_id } : {}),
          ...(class_name !== undefined ? { class_name } : {}),
          ...(control_type !== undefined ? { control_type } : {}),
          ...(max_results !== undefined ? { max_results } : {}),
          ...(include_offscreen !== undefined
            ? { include_offscreen }
            : {}),
        },
        device_id,
        provider_id,
        60_000,
      ),
  );

  const accessibilitySelectorSchema = z
    .object({
      automation_id: z.string().min(1).max(1024).optional(),
      name: z.string().min(1).max(1024).optional(),
      class_name: z.string().min(1).max(1024).optional(),
      control_type: z.string().min(1).max(128).optional(),
    })
    .refine(
      (value) =>
        value.automation_id !== undefined ||
        value.name !== undefined ||
        value.class_name !== undefined ||
        value.control_type !== undefined,
      {
        message: 'At least one exact accessibility selector is required.',
      },
    );

  server.registerTool(
    'windows_accessibility_invoke',
    {
      title: 'Invoke exact Windows accessibility element',
      description:
        'Invoke exactly one uniquely matched UI Automation element inside an exact HWND. Ambiguous selectors fail before any action.',
      inputSchema: {
        ...targetFields,
        hwnd: z
          .string()
          .min(1)
          .max(32)
          .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
        selector: accessibilitySelectorSchema,
      },
    },
    async ({ device_id, provider_id, hwnd, selector }) =>
      await execute(
        ctx,
        'windows.accessibility.invoke',
        { hwnd, selector },
        device_id,
        provider_id,
        60_000,
      ),
  );

  server.registerTool(
    'windows_accessibility_set_value',
    {
      title: 'Set exact Windows accessibility value',
      description:
        'Set ValuePattern on exactly one uniquely matched UI Automation element inside an exact HWND and verify the final value. The value itself is not echoed back.',
      inputSchema: {
        ...targetFields,
        hwnd: z
          .string()
          .min(1)
          .max(32)
          .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
        selector: accessibilitySelectorSchema,
        value: z.string().max(20_000),
      },
    },
    async ({ device_id, provider_id, hwnd, selector, value }) =>
      await execute(
        ctx,
        'windows.accessibility.set_value',
        { hwnd, selector, value },
        device_id,
        provider_id,
        60_000,
      ),
  );


  const pointerPointFields = {
    hwnd: z
      .string()
      .min(1)
      .max(32)
      .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
    coordinate_mode: z
      .enum(['client_pixels', 'normalized'])
      .optional(),
    x: z.number().finite(),
    y: z.number().finite(),
  };

  server.registerTool(
    'windows_pointer_position',
    {
      title: 'Read Windows pointer position',
      description:
        'Read the current screen cursor position and optionally resolve it into one exact HWND client coordinate system.',
      inputSchema: {
        ...targetFields,
        hwnd: z
          .string()
          .min(1)
          .max(32)
          .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/)
          .optional(),
      },
    },
    async ({ device_id, provider_id, hwnd }) =>
      await execute(
        ctx,
        'windows.pointer.position',
        {
          ...(hwnd ? { hwnd } : {}),
        },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_pointer_move',
    {
      title: 'Move pointer inside exact Windows HWND',
      description:
        'Move the cursor to a bounded client point inside one exact foreground HWND. The point must currently hit that same top-level window.',
      inputSchema: {
        ...targetFields,
        ...pointerPointFields,
      },
    },
    async ({
      device_id,
      provider_id,
      hwnd,
      coordinate_mode,
      x,
      y,
    }) =>
      await execute(
        ctx,
        'windows.pointer.move',
        {
          hwnd,
          ...(coordinate_mode ? { coordinate_mode } : {}),
          x,
          y,
        },
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'windows_pointer_click',
    {
      title: 'Click inside exact Windows HWND',
      description:
        'Move to and click a bounded client point inside one exact foreground HWND. Occluded points and wrong foreground targets fail closed before input.',
      inputSchema: {
        ...targetFields,
        ...pointerPointFields,
        button: z.enum(['left', 'right', 'middle']).optional(),
        count: z.number().int().min(1).max(3).optional(),
        interval_ms: z.number().int().min(20).max(1000).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      hwnd,
      coordinate_mode,
      x,
      y,
      button,
      count,
      interval_ms,
    }) =>
      await execute(
        ctx,
        'windows.pointer.click',
        {
          hwnd,
          ...(coordinate_mode ? { coordinate_mode } : {}),
          x,
          y,
          ...(button ? { button } : {}),
          ...(count !== undefined ? { count } : {}),
          ...(interval_ms !== undefined ? { interval_ms } : {}),
        },
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'windows_pointer_scroll',
    {
      title: 'Scroll inside exact Windows HWND',
      description:
        'Move to a bounded client point inside one exact foreground HWND and inject a vertical or horizontal wheel delta.',
      inputSchema: {
        ...targetFields,
        ...pointerPointFields,
        delta: z.number().int().min(-12_000).max(12_000),
        horizontal: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      hwnd,
      coordinate_mode,
      x,
      y,
      delta,
      horizontal,
    }) =>
      await execute(
        ctx,
        'windows.pointer.scroll',
        {
          hwnd,
          ...(coordinate_mode ? { coordinate_mode } : {}),
          x,
          y,
          delta,
          ...(horizontal !== undefined ? { horizontal } : {}),
        },
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'windows_virtual_pointer_status',
    {
      title: 'Read Nexowire virtual pointer status',
      description:
        'Read the independent Nexowire visual pointer state. This pointer is rendered as a click-through overlay and never moves the Windows system cursor.',
      inputSchema: {
        ...targetFields,
      },
    },
    async ({ device_id, provider_id }) =>
      await execute(
        ctx,
        'windows.virtual_pointer.status',
        {},
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_virtual_pointer_start',
    {
      title: 'Start Nexowire virtual pointer',
      description:
        'Start or reuse a visible, click-through Nexowire cursor overlay with independent coordinates. It does not inject mouse input or move the user cursor.',
      inputSchema: {
        ...targetFields,
        x: z.number().int().min(-100_000).max(100_000).optional(),
        y: z.number().int().min(-100_000).max(100_000).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        size: z.number().int().min(16).max(96).optional(),
        opacity: z.number().min(0.2).max(1).optional(),
        label: z.string().min(1).max(24).optional(),
        visible: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      x,
      y,
      color,
      size,
      opacity,
      label,
      visible,
    }) =>
      await execute(
        ctx,
        'windows.virtual_pointer.start',
        {
          ...(x !== undefined ? { x } : {}),
          ...(y !== undefined ? { y } : {}),
          ...(color ? { color } : {}),
          ...(size !== undefined ? { size } : {}),
          ...(opacity !== undefined ? { opacity } : {}),
          ...(label ? { label } : {}),
          ...(visible !== undefined ? { visible } : {}),
        },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_virtual_pointer_stop',
    {
      title: 'Stop Nexowire virtual pointer',
      description:
        'Stop the Nexowire click-through cursor overlay without touching the Windows system cursor.',
      inputSchema: {
        ...targetFields,
      },
    },
    async ({ device_id, provider_id }) =>
      await execute(
        ctx,
        'windows.virtual_pointer.stop',
        {},
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_virtual_pointer_move',
    {
      title: 'Move Nexowire virtual pointer',
      description:
        'Move only the independent Nexowire visual cursor to absolute virtual-screen coordinates. The user Windows cursor remains unchanged.',
      inputSchema: {
        ...targetFields,
        x: z.number().int().min(-100_000).max(100_000),
        y: z.number().int().min(-100_000).max(100_000),
        visible: z.boolean().optional(),
      },
    },
    async ({ device_id, provider_id, x, y, visible }) =>
      await execute(
        ctx,
        'windows.virtual_pointer.move',
        {
          x,
          y,
          ...(visible !== undefined ? { visible } : {}),
        },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_virtual_pointer_style',
    {
      title: 'Style Nexowire virtual pointer',
      description:
        'Change the Nexowire cursor color, size, opacity, or short label without affecting user input.',
      inputSchema: {
        ...targetFields,
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        size: z.number().int().min(16).max(96).optional(),
        opacity: z.number().min(0.2).max(1).optional(),
        label: z.string().min(1).max(24).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      color,
      size,
      opacity,
      label,
    }) =>
      await execute(
        ctx,
        'windows.virtual_pointer.style',
        {
          ...(color ? { color } : {}),
          ...(size !== undefined ? { size } : {}),
          ...(opacity !== undefined ? { opacity } : {}),
          ...(label ? { label } : {}),
        },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_virtual_pointer_visibility',
    {
      title: 'Show or hide Nexowire virtual pointer',
      description:
        'Show or hide the independent Nexowire visual cursor while preserving its position and style.',
      inputSchema: {
        ...targetFields,
        visible: z.boolean(),
      },
    },
    async ({ device_id, provider_id, visible }) =>
      await execute(
        ctx,
        'windows.virtual_pointer.visibility',
        { visible },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_private_desktop_status',
    {
      title: 'Read Nexowire private desktop status',
      description:
        'Read the isolated Nexowire Win32 desktop state, process ids, hidden-desktop window count, and current input desktop without switching the user-visible desktop.',
      inputSchema: {
        ...targetFields,
      },
    },
    async ({ device_id, provider_id }) =>
      await execute(
        ctx,
        'windows.private_desktop.status',
        {},
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_private_desktop_start',
    {
      title: 'Start Nexowire private desktop',
      description:
        'Create or reuse the isolated NexowirePrivate Win32 desktop and its private shell. This never switches the user-visible input desktop. An optional local shortcut lets the user enter the private desktop manually.',
      inputSchema: {
        ...targetFields,
        create_shortcut: z.boolean().optional(),
      },
    },
    async ({ device_id, provider_id, create_shortcut }) =>
      await execute(
        ctx,
        'windows.private_desktop.start',
        {
          ...(create_shortcut !== undefined
            ? { create_shortcut }
            : {}),
        },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_private_desktop_stop',
    {
      title: 'Stop Nexowire private desktop',
      description:
        'Stop the Nexowire private desktop shell and tracked private-desktop processes. The host fails safe toward the normal Default desktop.',
      inputSchema: {
        ...targetFields,
      },
    },
    async ({ device_id, provider_id }) =>
      await execute(
        ctx,
        'windows.private_desktop.stop',
        {},
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_private_desktop_launch',
    {
      title: 'Launch app on Nexowire private desktop',
      description:
        'Launch one executable onto the isolated NexowirePrivate Win32 desktop without moving it onto the user Default desktop or switching the visible input desktop.',
      inputSchema: {
        ...targetFields,
        executable: z.string().min(1).max(4096),
        args: z.array(z.string().max(32_768)).max(128).optional(),
        cwd: z.string().max(4096).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      executable,
      args,
      cwd,
    }) =>
      await execute(
        ctx,
        'windows.private_desktop.launch',
        {
          executable,
          ...(args ? { args } : {}),
          ...(cwd ? { cwd } : {}),
        },
        device_id,
        provider_id,
        60_000,
      ),
  );

  server.registerTool(
    'windows_private_desktop_windows',
    {
      title: 'List Nexowire private desktop windows',
      description:
        'Enumerate bounded top-level window metadata on the isolated NexowirePrivate Win32 desktop without switching the user-visible desktop.',
      inputSchema: {
        ...targetFields,
      },
    },
    async ({ device_id, provider_id }) =>
      await execute(
        ctx,
        'windows.private_desktop.windows',
        {},
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_private_pointer_move',
    {
      title: 'Move Nexowire private pointer',
      description:
        'Route a mouse-move message to one exact top-level HWND on the isolated NexowirePrivate desktop. Client-pixel coordinates are bounded to that HWND and the physical Windows cursor is not moved.',
      inputSchema: {
        ...targetFields,
        hwnd: z
          .string()
          .min(1)
          .max(32)
          .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
        x: z.number().int().min(0).max(32_767),
        y: z.number().int().min(0).max(32_767),
      },
    },
    async ({ device_id, provider_id, hwnd, x, y }) =>
      await execute(
        ctx,
        'windows.private_pointer.move',
        { hwnd, x, y },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_private_pointer_click',
    {
      title: 'Click Nexowire private desktop HWND',
      description:
        'Route one to three bounded mouse clicks to an exact HWND on NexowirePrivate without switching desktops or touching the physical cursor.',
      inputSchema: {
        ...targetFields,
        hwnd: z
          .string()
          .min(1)
          .max(32)
          .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
        x: z.number().int().min(0).max(32_767),
        y: z.number().int().min(0).max(32_767),
        button: z.enum(['left', 'right', 'middle']).optional(),
        clicks: z.number().int().min(1).max(3).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      hwnd,
      x,
      y,
      button,
      clicks,
    }) =>
      await execute(
        ctx,
        'windows.private_pointer.click',
        {
          hwnd,
          x,
          y,
          ...(button ? { button } : {}),
          ...(clicks !== undefined ? { clicks } : {}),
        },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_private_keyboard_type',
    {
      title: 'Type text into Nexowire private HWND',
      description:
        'Route Unicode WM_CHAR text directly to one exact top-level HWND on NexowirePrivate. This does not use SendInput and does not inject into the user-visible input desktop.',
      inputSchema: {
        ...targetFields,
        hwnd: z
          .string()
          .min(1)
          .max(32)
          .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
        text: z.string().min(1).max(20_000),
        interval_ms: z.number().int().min(0).max(100).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      hwnd,
      text,
      interval_ms,
    }) =>
      await execute(
        ctx,
        'windows.private_keyboard.type',
        {
          hwnd,
          text,
          ...(interval_ms !== undefined
            ? { interval_ms }
            : {}),
        },
        device_id,
        provider_id,
        Math.max(
          30_000,
          text.length * (interval_ms ?? 0) + 10_000,
        ),
      ),
  );

  server.registerTool(
    'windows_private_keyboard_hotkey',
    {
      title: 'Send hotkey to Nexowire private HWND',
      description:
        'Route a bounded key chord directly to one exact top-level HWND on NexowirePrivate without switching the visible input desktop. Supports modifiers, navigation keys, A-Z, 0-9, and F1-F24.',
      inputSchema: {
        ...targetFields,
        hwnd: z
          .string()
          .min(1)
          .max(32)
          .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
        keys: z.array(z.string().min(1).max(32)).min(1).max(8),
      },
    },
    async ({ device_id, provider_id, hwnd, keys }) =>
      await execute(
        ctx,
        'windows.private_keyboard.hotkey',
        { hwnd, keys },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_processes',
    {
      title: 'List Windows processes',
      description:
        'Read structured Windows process metadata without parsing formatted console tables.',
      inputSchema: {
        ...targetFields,
        name: z.string().min(1).max(260).optional(),
        pid: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(2000).optional(),
        include_command_line: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      name,
      pid,
      limit,
      include_command_line,
    }) =>
      await execute(
        ctx,
        'windows.processes',
        {
          ...(name ? { name } : {}),
          ...(pid !== undefined ? { pid } : {}),
          ...(limit ? { limit } : {}),
          ...(include_command_line !== undefined
            ? { include_command_line }
            : {}),
        },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'windows_services',
    {
      title: 'List Windows services',
      description:
        'Read structured Windows service state, startup mode, process id, account, and binary path.',
      inputSchema: {
        ...targetFields,
        name: z.string().min(1).max(260).optional(),
        state: z.enum(['running', 'stopped', 'paused', 'all']).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      },
    },
    async ({ device_id, provider_id, name, state, limit }) =>
      await execute(
        ctx,
        'windows.services',
        {
          ...(name ? { name } : {}),
          ...(state ? { state } : {}),
          ...(limit ? { limit } : {}),
        },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'windows_network_snapshot',
    {
      title: 'Windows network snapshot',
      description:
        'Read adapters, preferred addresses, DNS servers, default routes, and optionally TCP connections.',
      inputSchema: {
        ...targetFields,
        include_connections: z.boolean().optional(),
        connection_limit: z.number().int().min(1).max(5000).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      include_connections,
      connection_limit,
    }) =>
      await execute(
        ctx,
        'windows.network.snapshot',
        {
          ...(include_connections !== undefined
            ? { include_connections }
            : {}),
          ...(connection_limit ? { connection_limit } : {}),
        },
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'windows_service_control',
    {
      title: 'Control Windows service',
      description:
        'Start, stop, restart, or change startup type for one Windows service, then return verified final state.',
      inputSchema: {
        ...targetFields,
        name: z.string().min(1).max(260),
        action: z.enum(['start', 'stop', 'restart', 'set_startup']),
        startup_type: z
          .enum(['automatic', 'manual', 'disabled'])
          .optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      name,
      action,
      startup_type,
    }) =>
      await execute(
        ctx,
        'windows.service.control',
        {
          name,
          action,
          ...(startup_type ? { startup_type } : {}),
        },
        device_id,
        provider_id,
        60_000,
      ),
  );


  server.registerTool(
    'windows_registry_read',
    {
      title: 'Read Windows registry',
      description:
        'Read values and optional subkey names from one Windows registry key without shell table parsing.',
      inputSchema: {
        ...targetFields,
        hive: z.enum(['HKCU', 'HKLM', 'HKCR', 'HKU', 'HKCC']),
        path: z.string().max(4096).optional(),
        name: z.string().max(1024).optional(),
        include_subkeys: z.boolean().optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      hive,
      path,
      name,
      include_subkeys,
      limit,
    }) =>
      await execute(
        ctx,
        'windows.registry.read',
        {
          hive,
          ...(path !== undefined ? { path } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(include_subkeys !== undefined ? { include_subkeys } : {}),
          ...(limit ? { limit } : {}),
        },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'windows_tasks',
    {
      title: 'List Windows scheduled tasks',
      description:
        'Read structured scheduled-task name, path, state, author, description, and URI.',
      inputSchema: {
        ...targetFields,
        name: z.string().min(1).max(512).optional(),
        path: z.string().min(1).max(2048).optional(),
        state: z
          .enum(['all', 'ready', 'running', 'disabled', 'queued', 'unknown'])
          .optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      },
    },
    async ({ device_id, provider_id, name, path, state, limit }) =>
      await execute(
        ctx,
        'windows.tasks',
        {
          ...(name ? { name } : {}),
          ...(path ? { path } : {}),
          ...(state ? { state } : {}),
          ...(limit ? { limit } : {}),
        },
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'windows_eventlog_query',
    {
      title: 'Query Windows Event Log',
      description:
        'Query recent Windows events by log, provider, level, time window, and maximum result count with bounded per-message and total message text.',
      inputSchema: {
        ...targetFields,
        log_name: z.string().min(1).max(512).optional(),
        provider: z.string().min(1).max(512).optional(),
        level: z
          .enum([
            'all',
            'critical',
            'error',
            'warning',
            'information',
            'verbose',
          ])
          .optional(),
        since_minutes: z.number().int().min(1).max(43_200).optional(),
        max_events: z.number().int().min(1).max(2000).optional(),
        max_message_chars: z
          .number()
          .int()
          .min(0)
          .max(131_072)
          .optional(),
        max_total_message_chars: z
          .number()
          .int()
          .min(0)
          .max(4_194_304)
          .optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      log_name,
      provider,
      level,
      since_minutes,
      max_events,
      max_message_chars,
      max_total_message_chars,
    }) =>
      await execute(
        ctx,
        'windows.eventlog.query',
        {
          ...(log_name ? { log_name } : {}),
          ...(provider ? { provider } : {}),
          ...(level ? { level } : {}),
          ...(since_minutes ? { since_minutes } : {}),
          ...(max_events ? { max_events } : {}),
          ...(max_message_chars !== undefined
            ? { max_message_chars }
            : {}),
          ...(max_total_message_chars !== undefined
            ? { max_total_message_chars }
            : {}),
        },
        device_id,
        provider_id,
        45_000,
      ),
  );

  server.registerTool(
    'windows_firewall_rules',
    {
      title: 'List Windows firewall rules',
      description:
        'Read structured Windows firewall rules with optional name, direction, action, and enabled filters.',
      inputSchema: {
        ...targetFields,
        name: z.string().min(1).max(512).optional(),
        direction: z.enum(['all', 'inbound', 'outbound']).optional(),
        action: z.enum(['all', 'allow', 'block']).optional(),
        enabled: z.boolean().optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      name,
      direction,
      action,
      enabled,
      limit,
    }) =>
      await execute(
        ctx,
        'windows.firewall.rules',
        {
          ...(name ? { name } : {}),
          ...(direction ? { direction } : {}),
          ...(action ? { action } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
          ...(limit ? { limit } : {}),
        },
        device_id,
        provider_id,
        45_000,
      ),
  );


  server.registerTool(
    'windows_registry_set',
    {
      title: 'Set Windows registry value',
      description:
        'Optional idempotency_key prevents duplicate retries. Create or update one exact registry value and verify the stored value type/content. Use an empty name for the unnamed/default value.',
      inputSchema: {
        ...targetFields,
        ...idempotencyField,
        hive: z.enum(['HKCU', 'HKLM', 'HKCR', 'HKU', 'HKCC']),
        path: z.string().min(1).max(4096),
        name: z.string().max(1024),
        type: z.enum([
          'string',
          'expand_string',
          'dword',
          'qword',
          'multi_string',
          'binary',
        ]),
        value: z.union([
          z.string().max(4_194_304),
          z.number(),
          z.array(z.string().max(65_536)).max(4096),
        ]),
        create_key: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      hive,
      path,
      name,
      type,
      value,
      create_key,
      idempotency_key,
    }) =>
      await execute(
        ctx,
        'windows.registry.set',
        {
          hive,
          path,
          name,
          type,
          value,
          ...(create_key !== undefined ? { create_key } : {}),
        },
        device_id,
        provider_id,
        45_000,
        idempotency_key,
      ),
  );

  server.registerTool(
    'windows_registry_delete',
    {
      title: 'Delete Windows registry value or key',
      description:
        'Optional idempotency_key prevents duplicate retries. Delete one exact registry value, or delete one non-root key. Use an empty name for the unnamed/default value. Recursive key deletion must be explicitly enabled.',
      inputSchema: {
        ...targetFields,
        ...idempotencyField,
        hive: z.enum(['HKCU', 'HKLM', 'HKCR', 'HKU', 'HKCC']),
        path: z.string().min(1).max(4096),
        name: z.string().max(1024).optional(),
        recursive: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      hive,
      path,
      name,
      recursive,
      idempotency_key,
    }) =>
      await execute(
        ctx,
        'windows.registry.delete',
        {
          hive,
          path,
          ...(name !== undefined ? { name } : {}),
          ...(recursive !== undefined ? { recursive } : {}),
        },
        device_id,
        provider_id,
        45_000,
        idempotency_key,
      ),
  );

  server.registerTool(
    'windows_task_control',
    {
      title: 'Control exact Windows scheduled task',
      description:
        'Start, stop, enable, or disable one exact scheduled task, then verify its final state when applicable.',
      inputSchema: {
        ...targetFields,
        name: z.string().min(1).max(512),
        path: z.string().min(1).max(2048).optional(),
        action: z.enum(['start', 'stop', 'enable', 'disable']),
      },
    },
    async ({ device_id, provider_id, name, path, action }) =>
      await execute(
        ctx,
        'windows.task.control',
        {
          name,
          ...(path ? { path } : {}),
          action,
        },
        device_id,
        provider_id,
        60_000,
      ),
  );

  server.registerTool(
    'windows_firewall_control',
    {
      title: 'Control exact Windows firewall rule',
      description:
        'Enable, disable, or change Allow/Block action for one exact firewall rule and verify final state.',
      inputSchema: {
        ...targetFields,
        name: z.string().min(1).max(512),
        action: z.enum(['enable', 'disable', 'set_action']),
        rule_action: z.enum(['allow', 'block']).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      name,
      action,
      rule_action,
    }) =>
      await execute(
        ctx,
        'windows.firewall.control',
        {
          name,
          action,
          ...(rule_action ? { rule_action } : {}),
        },
        device_id,
        provider_id,
        60_000,
      ),
  );


  server.registerTool(
    'windows_environment_list',
    {
      title: 'List Windows environment variable names',
      description:
        'List exact environment variable names from process, user, or machine scope without returning their values.',
      inputSchema: {
        ...targetFields,
        scope: z.enum(['process', 'user', 'machine']).optional(),
        prefix: z.string().max(1024).optional(),
        limit: z.number().int().min(1).max(2048).optional(),
      },
    },
    async ({ device_id, provider_id, scope, prefix, limit }) =>
      await execute(
        ctx,
        'windows.environment.list',
        {
          ...(scope ? { scope } : {}),
          ...(prefix !== undefined ? { prefix } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_environment_read',
    {
      title: 'Read selected Windows environment variables',
      description:
        'Read exact environment variable names from process, user, or machine scope. Sensitive-looking names are redacted unless explicitly requested.',
      inputSchema: {
        ...targetFields,
        scope: z.enum(['process', 'user', 'machine']).optional(),
        names: z.array(z.string().min(1).max(1024)).min(1).max(64),
        reveal_sensitive: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      scope,
      names,
      reveal_sensitive,
    }) =>
      await execute(
        ctx,
        'windows.environment.read',
        {
          ...(scope ? { scope } : {}),
          names,
          ...(reveal_sensitive !== undefined
            ? { reveal_sensitive }
            : {}),
        },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'windows_environment_set',
    {
      title: 'Set Windows environment variable',
      description:
        'Optional idempotency_key prevents duplicate retries. Set one exact environment variable in process, user, or machine scope and verify the stored value. User/machine changes apply to newly created processes.',
      inputSchema: {
        ...targetFields,
        ...idempotencyField,
        scope: z.enum(['process', 'user', 'machine']).optional(),
        name: z.string().min(1).max(1024),
        value: z.string().max(32_767),
      },
    },
    async ({
      device_id,
      provider_id,
      scope,
      name,
      value,
      idempotency_key,
    }) =>
      await execute(
        ctx,
        'windows.environment.set',
        {
          ...(scope ? { scope } : {}),
          name,
          value,
        },
        device_id,
        provider_id,
        45_000,
        idempotency_key,
      ),
  );

  server.registerTool(
    'windows_environment_delete',
    {
      title: 'Delete Windows environment variable',
      description:
        'Optional idempotency_key prevents duplicate retries. Delete one exact environment variable from process, user, or machine scope and verify removal.',
      inputSchema: {
        ...targetFields,
        ...idempotencyField,
        scope: z.enum(['process', 'user', 'machine']).optional(),
        name: z.string().min(1).max(1024),
      },
    },
    async ({
      device_id,
      provider_id,
      scope,
      name,
      idempotency_key,
    }) =>
      await execute(
        ctx,
        'windows.environment.delete',
        {
          ...(scope ? { scope } : {}),
          name,
        },
        device_id,
        provider_id,
        45_000,
        idempotency_key,
      ),
  );

  server.registerTool(
    'shell_exec',
    {
      title: 'Execute shell command',
      description:
        'Execute a command through pwsh, Windows PowerShell, cmd, bash, or sh on a target computer.',
      inputSchema: {
        ...targetFields,
        command: z.string().min(1).max(200_000),
        shell: z.enum(['pwsh', 'powershell', 'cmd', 'bash', 'sh']).optional(),
        cwd: z.string().max(4096).optional(),
        timeout_ms: z.number().int().min(100).max(600_000).optional(),
        max_output_bytes: z.number().int().min(1024).max(16_777_216).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      command,
      shell,
      cwd,
      timeout_ms,
      max_output_bytes,
    }) =>
      await execute(
        ctx,
        'shell.exec',
        {
          command,
          ...(shell ? { shell } : {}),
          ...(cwd ? { cwd } : {}),
          ...(timeout_ms ? { timeout_ms } : {}),
          ...(max_output_bytes ? { max_output_bytes } : {}),
        },
        device_id,
        provider_id,
        timeout_ms,
      ),
  );

  server.registerTool(
    'process_start',
    {
      title: 'Start process session',
      description: 'Start a long-running or interactive process and return a reusable session id. durable=true uses a Nexowire sidecar worker so stdin/stdout/stderr can be reattached after native-agent restart.',
      inputSchema: {
        ...targetFields,
        command: z.string().min(1).max(200_000),
        shell: z.enum(['pwsh', 'powershell', 'cmd', 'bash', 'sh']).optional(),
        cwd: z.string().max(4096).optional(),
        name: z.string().min(1).max(128).optional(),
        durable: z.boolean().optional(),
        max_buffer_bytes: z.number().int().min(65_536).max(16_777_216).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      command,
      shell,
      cwd,
      name,
      durable,
      max_buffer_bytes,
    }) =>
      await execute(
        ctx,
        'process.start',
        {
          command,
          ...(shell ? { shell } : {}),
          ...(cwd ? { cwd } : {}),
          ...(name ? { name } : {}),
          ...(durable !== undefined ? { durable } : {}),
          ...(max_buffer_bytes ? { max_buffer_bytes } : {}),
        },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'process_read',
    {
      title: 'Read process session',
      description: 'Read incremental stdout/stderr events and process state from a running session.',
      inputSchema: {
        ...targetFields,
        session_id: z.string().uuid(),
        after_seq: z.number().int().min(0).optional(),
        max_events: z.number().int().min(1).max(1000).optional(),
        wait_ms: z.number().int().min(0).max(10_000).optional(),
      },
    },
    async ({ device_id, provider_id, session_id, after_seq, max_events, wait_ms }) =>
      await execute(
        ctx,
        'process.read',
        {
          session_id,
          ...(after_seq !== undefined ? { after_seq } : {}),
          ...(max_events ? { max_events } : {}),
          ...(wait_ms !== undefined ? { wait_ms } : {}),
        },
        device_id,
        provider_id,
        wait_ms ? wait_ms + 5_000 : undefined,
      ),
  );

  server.registerTool(
    'process_write',
    {
      title: 'Write process input',
      description: 'Send input to an interactive process session.',
      inputSchema: {
        ...targetFields,
        session_id: z.string().uuid(),
        input: z.string().max(1_048_576),
        append_newline: z.boolean().optional(),
      },
    },
    async ({ device_id, provider_id, session_id, input, append_newline }) =>
      await execute(
        ctx,
        'process.write',
        { session_id, input, ...(append_newline !== undefined ? { append_newline } : {}) },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'process_stop',
    {
      title: 'Stop process session',
      description: 'Terminate a managed process session and its process tree when possible.',
      inputSchema: { ...targetFields, session_id: z.string().uuid() },
    },
    async ({ device_id, provider_id, session_id }) =>
      await execute(ctx, 'process.stop', { session_id }, device_id, provider_id),
  );

  server.registerTool(
    'process_list',
    {
      title: 'List process sessions',
      description: 'List managed long-running and interactive process sessions on a target.',
      inputSchema: targetFields,
    },
    async ({ device_id, provider_id }) =>
      await execute(ctx, 'process.list', {}, device_id, provider_id),
  );


  server.registerTool(
    'process_prune',
    {
      title: 'Prune process session history',
      description:
        'Remove exited/lost process-session history older than the requested age. Running or orphaned sessions are never pruned.',
      inputSchema: {
        ...targetFields,
        older_than_ms: z
          .number()
          .int()
          .min(0)
          .max(2_592_000_000)
          .optional(),
      },
    },
    async ({ device_id, provider_id, older_than_ms }) =>
      await execute(
        ctx,
        'process.prune',
        {
          ...(older_than_ms !== undefined ? { older_than_ms } : {}),
        },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'wsl_exec',
    {
      title: 'Execute in WSL2',
      description:
        'Execute a bash command inside a Windows Subsystem for Linux distribution.',
      inputSchema: {
        ...targetFields,
        command: z.string().min(1).max(200_000),
        distro: z.string().min(1).max(128).optional(),
        cwd: z.string().max(4096).optional(),
        timeout_ms: z.number().int().min(100).max(600_000).optional(),
      },
    },
    async ({ device_id, provider_id, command, distro, cwd, timeout_ms }) =>
      await execute(
        ctx,
        'wsl.exec',
        {
          command,
          ...(distro ? { distro } : {}),
          ...(cwd ? { cwd } : {}),
          ...(timeout_ms ? { timeout_ms } : {}),
        },
        device_id,
        provider_id,
        timeout_ms,
      ),
  );

  server.registerTool(
    'file_read',
    {
      title: 'Read file',
      description: 'Read a text or base64 file from an allowed agent path.',
      inputSchema: {
        ...targetFields,
        path: z.string().min(1).max(4096),
        encoding: z.enum(['utf8', 'base64']).optional(),
        max_bytes: z.number().int().min(1).max(16_777_216).optional(),
        include_sha256: z.boolean().optional(),
      },
    },
    async ({ device_id, provider_id, path, encoding, max_bytes, include_sha256 }) =>
      await execute(
        ctx,
        'files.read',
        {
          path,
          ...(encoding ? { encoding } : {}),
          ...(max_bytes ? { max_bytes } : {}),
          ...(include_sha256 !== undefined ? { include_sha256 } : {}),
        },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'file_read_many',
    {
      title: 'Read multiple files',
      description:
        'Read up to 64 files in one remote round trip with per-file and total output limits.',
      inputSchema: {
        ...targetFields,
        paths: z.array(z.string().min(1).max(4096)).min(1).max(64),
        encoding: z.enum(['utf8', 'base64']).optional(),
        max_bytes_each: z.number().int().min(1).max(16_777_216).optional(),
        max_total_bytes: z.number().int().min(1024).max(67_108_864).optional(),
        include_sha256: z.boolean().optional(),
      },
    },
    async ({ device_id, provider_id, paths, encoding, max_bytes_each, max_total_bytes, include_sha256 }) =>
      await execute(
        ctx,
        'files.read_many',
        {
          paths,
          ...(encoding ? { encoding } : {}),
          ...(max_bytes_each ? { max_bytes_each } : {}),
          ...(max_total_bytes ? { max_total_bytes } : {}),
          ...(include_sha256 !== undefined ? { include_sha256 } : {}),
        },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'file_write',
    {
      title: 'Write file',
      description: 'Write or append a file inside the native agent path allowlist.',
      inputSchema: {
        ...targetFields,
        ...idempotencyField,
        path: z.string().min(1).max(4096),
        content: z.string(),
        encoding: z.enum(['utf8', 'base64']).optional(),
        mode: z.enum(['overwrite', 'append']).optional(),
        create_parents: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      path,
      content,
      encoding,
      mode,
      create_parents,
      idempotency_key,
    }) =>
      await execute(
        ctx,
        'files.write',
        {
          path,
          content,
          ...(encoding ? { encoding } : {}),
          ...(mode ? { mode } : {}),
          ...(create_parents !== undefined ? { create_parents } : {}),
        },
        device_id,
        provider_id,
        undefined,
        idempotency_key,
      ),
  );


  server.registerTool(
    'file_stat',
    {
      title: 'File metadata',
      description: 'Read metadata for a file, directory, or symlink inside the agent allowlist.',
      inputSchema: {
        ...targetFields,
        path: z.string().min(1).max(4096),
      },
    },
    async ({ device_id, provider_id, path }) =>
      await execute(ctx, 'files.stat', { path }, device_id, provider_id),
  );

  server.registerTool(
    'file_hash',
    {
      title: 'Hash file',
      description:
        'Compute a SHA-256 digest for one allowed file so later edits can detect stale content.',
      inputSchema: {
        ...targetFields,
        path: z.string().min(1).max(4096),
        max_bytes: z.number().int().min(1).max(268_435_456).optional(),
      },
    },
    async ({ device_id, provider_id, path, max_bytes }) =>
      await execute(
        ctx,
        'files.hash',
        { path, ...(max_bytes ? { max_bytes } : {}) },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'file_mkdir',
    {
      title: 'Create directory',
      description: 'Create a directory inside the agent allowlist.',
      inputSchema: {
        ...targetFields,
        ...idempotencyField,
        path: z.string().min(1).max(4096),
        recursive: z.boolean().optional(),
      },
    },
    async ({ device_id, provider_id, path, recursive, idempotency_key }) =>
      await execute(
        ctx,
        'files.mkdir',
        { path, ...(recursive !== undefined ? { recursive } : {}) },
        device_id,
        provider_id,
        undefined,
        idempotency_key,
      ),
  );

  server.registerTool(
    'file_copy',
    {
      title: 'Copy file or directory',
      description: 'Copy a file or directory between allowed paths.',
      inputSchema: {
        ...targetFields,
        source: z.string().min(1).max(4096),
        destination: z.string().min(1).max(4096),
        overwrite: z.boolean().optional(),
        recursive: z.boolean().optional(),
        create_parents: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      source,
      destination,
      overwrite,
      recursive,
      create_parents,
    }) =>
      await execute(
        ctx,
        'files.copy',
        {
          source,
          destination,
          ...(overwrite !== undefined ? { overwrite } : {}),
          ...(recursive !== undefined ? { recursive } : {}),
          ...(create_parents !== undefined ? { create_parents } : {}),
        },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'file_move',
    {
      title: 'Move file or directory',
      description: 'Move or rename a file or directory between allowed paths.',
      inputSchema: {
        ...targetFields,
        source: z.string().min(1).max(4096),
        destination: z.string().min(1).max(4096),
        overwrite: z.boolean().optional(),
        recursive: z.boolean().optional(),
        create_parents: z.boolean().optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      source,
      destination,
      overwrite,
      recursive,
      create_parents,
    }) =>
      await execute(
        ctx,
        'files.move',
        {
          source,
          destination,
          ...(overwrite !== undefined ? { overwrite } : {}),
          ...(recursive !== undefined ? { recursive } : {}),
          ...(create_parents !== undefined ? { create_parents } : {}),
        },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'file_delete',
    {
      title: 'Delete file or directory',
      description:
        'Delete one allowed file or directory. Recursive directory deletion must be explicitly enabled.',
      inputSchema: {
        ...targetFields,
        path: z.string().min(1).max(4096),
        recursive: z.boolean().optional(),
      },
    },
    async ({ device_id, provider_id, path, recursive }) =>
      await execute(
        ctx,
        'files.delete',
        { path, ...(recursive !== undefined ? { recursive } : {}) },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'file_patch',
    {
      title: 'Patch text file',
      description:
        'Optional idempotency_key records exact-at-most-once execution. Apply exact text replacements with occurrence-count and optional SHA-256 stale-read checks before writing.',
      inputSchema: {
        ...targetFields,
        ...idempotencyField,
        path: z.string().min(1).max(4096),
        operations: z
          .array(
            z.object({
              old_text: z.string().min(1).max(1_048_576),
              new_text: z.string().max(1_048_576),
              expected_count: z.number().int().min(1).max(10_000).optional(),
            }),
          )
          .min(1)
          .max(100),
        max_bytes: z.number().int().min(1).max(16_777_216).optional(),
        expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      path,
      operations,
      max_bytes,
      expected_sha256,
      idempotency_key,
    }) =>
      await execute(
        ctx,
        'files.patch',
        {
          path,
          operations,
          ...(max_bytes ? { max_bytes } : {}),
          ...(expected_sha256 ? { expected_sha256 } : {}),
        },
        device_id,
        provider_id,
        undefined,
        idempotency_key,
      ),
  );

  server.registerTool(
    'file_list',
    {
      title: 'List files',
      description: 'List a directory tree on a target computer.',
      inputSchema: {
        ...targetFields,
        path: z.string().min(1).max(4096),
        depth: z.number().int().min(1).max(5).optional(),
        max_entries: z.number().int().min(1).max(5000).optional(),
      },
    },
    async ({ device_id, provider_id, path, depth, max_entries }) =>
      await execute(
        ctx,
        'files.list',
        {
          path,
          ...(depth ? { depth } : {}),
          ...(max_entries ? { max_entries } : {}),
        },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'search_text',
    {
      title: 'Search text in files',
      description:
        'Search a directory tree for literal text or a regular expression with bounded structured results.',
      inputSchema: {
        ...targetFields,
        path: z.string().min(1).max(4096),
        query: z.string().min(1).max(2000),
        regex: z.boolean().optional(),
        case_sensitive: z.boolean().optional(),
        max_matches: z.number().int().min(1).max(5000).optional(),
        max_files: z.number().int().min(1).max(100_000).optional(),
        max_file_bytes: z.number().int().min(1024).max(16_777_216).optional(),
        include_hidden: z.boolean().optional(),
        exclude_dirs: z.array(z.string().min(1).max(255)).max(100).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      path,
      query,
      regex,
      case_sensitive,
      max_matches,
      max_files,
      max_file_bytes,
      include_hidden,
      exclude_dirs,
    }) =>
      await execute(
        ctx,
        'search.text',
        {
          path,
          query,
          ...(regex !== undefined ? { regex } : {}),
          ...(case_sensitive !== undefined ? { case_sensitive } : {}),
          ...(max_matches ? { max_matches } : {}),
          ...(max_files ? { max_files } : {}),
          ...(max_file_bytes ? { max_file_bytes } : {}),
          ...(include_hidden !== undefined ? { include_hidden } : {}),
          ...(exclude_dirs ? { exclude_dirs } : {}),
        },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'workspace_snapshot',
    {
      title: 'Workspace snapshot',
      description:
        'Get compact Git workspace state before resuming or modifying a project.',
      inputSchema: {
        ...targetFields,
        path: z.string().min(1).max(4096),
      },
    },
    async ({ device_id, provider_id, path }) =>
      await execute(
        ctx,
        'workspace.snapshot',
        { path },
        device_id,
        provider_id,
      ),
  );


  server.registerTool(
    'workspace_detect',
    {
      title: 'Detect workspace',
      description:
        'Detect project types, manifests, package manager, scripts, and available structured checks for a workspace.',
      inputSchema: {
        ...targetFields,
        path: z.string().min(1).max(4096),
      },
    },
    async ({ device_id, provider_id, path }) =>
      await execute(
        ctx,
        'workspace.detect',
        { path },
        device_id,
        provider_id,
      ),
  );

  server.registerTool(
    'workspace_run_checks',
    {
      title: 'Run workspace checks',
      description:
        'Run one or more advertised build/test/lint/typecheck checks, optionally in parallel, with bounded output.',
      inputSchema: {
        ...targetFields,
        path: z.string().min(1).max(4096),
        checks: z.array(z.string().min(1).max(128)).min(1).max(8),
        parallel: z.boolean().optional(),
        timeout_ms: z.number().int().min(100).max(600_000).optional(),
        max_output_bytes: z
          .number()
          .int()
          .min(1024)
          .max(16_777_216)
          .optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      path,
      checks,
      parallel,
      timeout_ms,
      max_output_bytes,
    }) =>
      await execute(
        ctx,
        'workspace.checks',
        {
          path,
          checks,
          ...(parallel !== undefined ? { parallel } : {}),
          ...(timeout_ms ? { timeout_ms } : {}),
          ...(max_output_bytes ? { max_output_bytes } : {}),
        },
        device_id,
        provider_id,
        timeout_ms ? timeout_ms + 10_000 : undefined,
      ),
  );

  server.registerTool(
    'task_run_graph',
    {
      title: 'Run dependency-aware task graph',
      description:
        'Run up to 32 shell jobs with explicit dependencies, bounded parallelism, output limits, per-job timeouts, and a total graph timeout.',
      inputSchema: {
        ...targetFields,
        graph_id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
          .optional(),
        resume: z.boolean().optional(),
        retry_failed: z.boolean().optional(),
        retry_unknown: z.boolean().optional(),
        jobs: z
          .array(
            z.object({
              id: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
              command: z.string().min(1).max(200_000),
              shell: z
                .enum(['pwsh', 'powershell', 'cmd', 'bash', 'sh'])
                .optional(),
              cwd: z.string().max(4096).optional(),
              depends_on: z
                .array(
                  z
                    .string()
                    .min(1)
                    .max(128)
                    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
                )
                .max(31)
                .optional(),
              timeout_ms: z
                .number()
                .int()
                .min(100)
                .max(600_000)
                .optional(),
              max_output_bytes: z
                .number()
                .int()
                .min(1024)
                .max(16_777_216)
                .optional(),
              artifacts: z
                .array(z.string().min(1).max(4096))
                .max(32)
                .optional(),
              artifact_max_bytes: z
                .number()
                .int()
                .min(1)
                .max(1_073_741_824)
                .optional(),
            }),
          )
          .min(1)
          .max(32),
        max_parallel: z.number().int().min(1).max(8).optional(),
        stop_on_failure: z.boolean().optional(),
        default_timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(600_000)
          .optional(),
        total_timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(3_600_000)
          .optional(),
        default_max_output_bytes: z
          .number()
          .int()
          .min(1024)
          .max(16_777_216)
          .optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      graph_id,
      resume,
      retry_failed,
      retry_unknown,
      jobs,
      max_parallel,
      stop_on_failure,
      default_timeout_ms,
      total_timeout_ms,
      default_max_output_bytes,
    }) => {
      const graphTimeout = total_timeout_ms ?? 600_000;
      return await execute(
        ctx,
        'task.graph.run',
        {
          ...(graph_id ? { graph_id } : {}),
          ...(resume !== undefined ? { resume } : {}),
          ...(retry_failed !== undefined ? { retry_failed } : {}),
          ...(retry_unknown !== undefined ? { retry_unknown } : {}),
          jobs,
          ...(max_parallel !== undefined ? { max_parallel } : {}),
          ...(stop_on_failure !== undefined ? { stop_on_failure } : {}),
          ...(default_timeout_ms !== undefined
            ? { default_timeout_ms }
            : {}),
          ...(total_timeout_ms !== undefined ? { total_timeout_ms } : {}),
          ...(default_max_output_bytes !== undefined
            ? { default_max_output_bytes }
            : {}),
        },
        device_id,
        provider_id,
        graphTimeout + 15_000,
      );
    },
  );

  server.registerTool(
    'task_graph_list',
    {
      title: 'List persisted task graphs',
      description:
        'List persisted task-graph metadata and job states. Command text and output are not persisted.',
      inputSchema: {
        ...targetFields,
      },
    },
    async ({ device_id, provider_id }) =>
      await execute(
        ctx,
        'task.graph.list',
        {},
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'task_graph_get',
    {
      title: 'Get persisted task graph',
      description:
        'Read one persisted task graph by graph_id, including resumable state and unknown-state jobs after restart.',
      inputSchema: {
        ...targetFields,
        graph_id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
      },
    },
    async ({ device_id, provider_id, graph_id }) =>
      await execute(
        ctx,
        'task.graph.get',
        { graph_id },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'task_artifact_list',
    {
      title: 'List persisted task artifacts',
      description:
        'List bounded persisted task-graph artifact metadata including graph/job state, path, size, SHA-256, and mtime. Artifact contents are never returned.',
      inputSchema: {
        ...targetFields,
        graph_id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
          .optional(),
        job_id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
          .optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      graph_id,
      job_id,
      limit,
    }) =>
      await execute(
        ctx,
        'task.artifact.list',
        {
          ...(graph_id ? { graph_id } : {}),
          ...(job_id ? { job_id } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'task_artifact_verify',
    {
      title: 'Verify persisted task artifacts',
      description:
        'Re-stat and re-hash persisted artifacts for one task graph through the native file policy. Reports verified, changed, missing, unverified-too-large, or error without returning artifact contents.',
      inputSchema: {
        ...targetFields,
        graph_id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        job_id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
          .optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        max_bytes_each: z
          .number()
          .int()
          .min(1)
          .max(1_073_741_824)
          .optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      graph_id,
      job_id,
      limit,
      max_bytes_each,
    }) =>
      await execute(
        ctx,
        'task.artifact.verify',
        {
          graph_id,
          ...(job_id ? { job_id } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(max_bytes_each !== undefined
            ? { max_bytes_each }
            : {}),
        },
        device_id,
        provider_id,
        60_000,
      ),
  );

  server.registerTool(
    'task_graph_prune',
    {
      title: 'Prune persisted task graphs',
      description:
        'Delete completed/interrupted persisted task-graph metadata older than a requested age. Running graphs are never pruned.',
      inputSchema: {
        ...targetFields,
        older_than_ms: z
          .number()
          .int()
          .min(0)
          .max(2_592_000_000)
          .optional(),
      },
    },
    async ({ device_id, provider_id, older_than_ms }) =>
      await execute(
        ctx,
        'task.graph.prune',
        {
          ...(older_than_ms !== undefined ? { older_than_ms } : {}),
        },
        device_id,
        provider_id,
        30_000,
      ),
  );

  const runbookStepIdSchema = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

  const runbookTaskJobSchema = z.object({
    id: runbookStepIdSchema,
    command: z.string().min(1).max(200_000),
    shell: z
      .enum(['pwsh', 'powershell', 'cmd', 'bash', 'sh'])
      .optional(),
    cwd: z.string().max(4096).optional(),
    depends_on: z.array(runbookStepIdSchema).max(31).optional(),
    timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(600_000)
      .optional(),
    max_output_bytes: z
      .number()
      .int()
      .min(1024)
      .max(16_777_216)
      .optional(),
    artifacts: z
      .array(z.string().min(1).max(4096))
      .max(32)
      .optional(),
    artifact_max_bytes: z
      .number()
      .int()
      .min(1)
      .max(1_073_741_824)
      .optional(),
  });

  const runbookTaskGraphSchema = z.object({
    jobs: z.array(runbookTaskJobSchema).min(1).max(32),
    max_parallel: z.number().int().min(1).max(8).optional(),
    stop_on_failure: z.boolean().optional(),
    default_timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(600_000)
      .optional(),
    total_timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(3_600_000)
      .optional(),
    default_max_output_bytes: z
      .number()
      .int()
      .min(1024)
      .max(16_777_216)
      .optional(),
  });

  const runbookAssertionInputSchema = z.object({
    assertions: z
      .array(postconditionAssertionSchema)
      .min(1)
      .max(32),
    max_parallel: z.number().int().min(1).max(8).optional(),
    stop_on_failure: z.boolean().optional(),
  });

  const runbookStepSchema = z.discriminatedUnion('kind', [
    z.object({
      id: runbookStepIdSchema,
      kind: z.literal('task_graph'),
      depends_on: z
        .array(runbookStepIdSchema)
        .max(31)
        .optional(),
      task_graph: runbookTaskGraphSchema,
    }),
    z.object({
      id: runbookStepIdSchema,
      kind: z.literal('assertions'),
      depends_on: z
        .array(runbookStepIdSchema)
        .max(31)
        .optional(),
      assertions: runbookAssertionInputSchema,
    }),
  ]);

  server.registerTool(
    'runbook_run',
    {
      title: 'Run durable resumable runbook',
      description:
        'Run a persistent dependency-aware workflow whose steps are durable task graphs or read-only postcondition assertion groups. Only metadata/spec hashes are persisted by the runbook layer; command/output payloads remain in the underlying bounded execution response.',
      inputSchema: {
        ...targetFields,
        runbook_id: runbookStepIdSchema,
        resume: z.boolean().optional(),
        retry_failed: z.boolean().optional(),
        retry_unknown: z.boolean().optional(),
        steps: z.array(runbookStepSchema).min(1).max(64),
        max_parallel: z.number().int().min(1).max(8).optional(),
        stop_on_failure: z.boolean().optional(),
        total_timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(7_200_000)
          .optional(),
      },
    },
    async ({
      device_id,
      provider_id,
      runbook_id,
      resume,
      retry_failed,
      retry_unknown,
      steps,
      max_parallel,
      stop_on_failure,
      total_timeout_ms,
    }) => {
      const timeout = total_timeout_ms ?? 1_800_000;
      return await execute(
        ctx,
        'runbook.run',
        {
          runbook_id,
          ...(resume !== undefined ? { resume } : {}),
          ...(retry_failed !== undefined
            ? { retry_failed }
            : {}),
          ...(retry_unknown !== undefined
            ? { retry_unknown }
            : {}),
          steps,
          ...(max_parallel !== undefined
            ? { max_parallel }
            : {}),
          ...(stop_on_failure !== undefined
            ? { stop_on_failure }
            : {}),
          ...(total_timeout_ms !== undefined
            ? { total_timeout_ms }
            : {}),
        },
        device_id,
        provider_id,
        timeout + 15_000,
      );
    },
  );

  server.registerTool(
    'runbook_list',
    {
      title: 'List persisted runbooks',
      description:
        'List payload-free durable runbook metadata and step states for one native device.',
      inputSchema: {
        ...targetFields,
      },
    },
    async ({ device_id, provider_id }) =>
      await execute(
        ctx,
        'runbook.list',
        {},
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'runbook_get',
    {
      title: 'Get persisted runbook',
      description:
        'Read one durable runbook checkpoint including step status, attempts, derived task-graph references, and restart unknown-state markers.',
      inputSchema: {
        ...targetFields,
        runbook_id: runbookStepIdSchema,
      },
    },
    async ({ device_id, provider_id, runbook_id }) =>
      await execute(
        ctx,
        'runbook.get',
        { runbook_id },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'runbook_prune',
    {
      title: 'Prune persisted runbooks',
      description:
        'Delete completed/interrupted runbook metadata older than a requested age. Running runbooks are never pruned.',
      inputSchema: {
        ...targetFields,
        older_than_ms: z
          .number()
          .int()
          .min(0)
          .max(2_592_000_000)
          .optional(),
      },
    },
    async ({ device_id, provider_id, older_than_ms }) =>
      await execute(
        ctx,
        'runbook.prune',
        {
          ...(older_than_ms !== undefined
            ? { older_than_ms }
            : {}),
        },
        device_id,
        provider_id,
        30_000,
      ),
  );

  server.registerTool(
    'workspace_checkpoint_save',
    {
      title: 'Save workspace checkpoint',
      description:
        'Persist what was completed, what remains, and the last commands so work can resume later.',
      inputSchema: {
        device_id: z.string().min(1).max(128),
        workspace_id: z.string().min(1).max(256),
        cwd: z.string().max(4096).optional(),
        summary: z.string().max(20_000),
        completed: z.array(z.string().max(4096)).max(200).optional(),
        remaining: z.array(z.string().max(4096)).max(200).optional(),
        last_commands: z.array(z.string().max(8192)).max(100).optional(),
      },
    },
    async ({
      device_id,
      workspace_id,
      cwd,
      summary,
      completed,
      remaining,
      last_commands,
    }) =>
      toolResult(
        await ctx.workspaces.save({
          deviceId: device_id,
          workspaceId: workspace_id,
          ...(cwd ? { cwd } : {}),
          summary,
          completed: completed ?? [],
          remaining: remaining ?? [],
          lastCommands: last_commands ?? [],
        }),
      ),
  );

  server.registerTool(
    'workspace_checkpoint_get',
    {
      title: 'Load workspace checkpoint',
      description: 'Load the latest persisted state for a project workspace.',
      inputSchema: {
        device_id: z.string().min(1).max(128),
        workspace_id: z.string().min(1).max(256),
      },
    },
    async ({ device_id, workspace_id }) =>
      toolResult({
        checkpoint: await ctx.workspaces.get(device_id, workspace_id),
      }),
  );

  server.registerTool(
    'workspace_checkpoint_list',
    {
      title: 'List workspace checkpoints',
      description: 'List resumable Nexowire workspace checkpoints.',
      inputSchema: {},
    },
    async () => toolResult({ checkpoints: await ctx.workspaces.list() }),
  );

  server.registerTool(
    'audit_recent',
    {
      title: 'Recent Nexowire audit events',
      description:
        'Read recent operation metadata. Command inputs and file contents are intentionally not logged.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ limit }) =>
      toolResult({ events: ctx.audit?.list(limit ?? 50) ?? [] }),
  );

  server.registerTool(
    'audit_query',
    {
      title: 'Query persistent Nexowire audit history',
      description:
        'Query a bounded tail window of the persistent payload-free audit log with exact metadata filters. Command inputs, secrets, and file contents are not logged.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
        capability: z.string().min(1).max(256).optional(),
        status: z.enum(['started', 'succeeded', 'failed']).optional(),
        target_id: z.string().min(1).max(128).optional(),
        provider_id: z.string().min(1).max(128).optional(),
        operation_id: z.string().min(1).max(128).optional(),
        from_at: z.string().datetime().optional(),
        to_at: z.string().datetime().optional(),
        max_scan_bytes: z
          .number()
          .int()
          .min(65_536)
          .max(33_554_432)
          .optional(),
      },
    },
    async ({
      limit,
      capability,
      status,
      target_id,
      provider_id,
      operation_id,
      from_at,
      to_at,
      max_scan_bytes,
    }) =>
      toolResult(
        ctx.audit
          ? await ctx.audit.query({
              ...(limit !== undefined ? { limit } : {}),
              ...(capability ? { capability } : {}),
              ...(status ? { status } : {}),
              ...(target_id ? { targetId: target_id } : {}),
              ...(provider_id ? { providerId: provider_id } : {}),
              ...(operation_id ? { operationId: operation_id } : {}),
              ...(from_at ? { fromAt: from_at } : {}),
              ...(to_at ? { toAt: to_at } : {}),
              ...(max_scan_bytes !== undefined
                ? { maxScanBytes: max_scan_bytes }
                : {}),
            })
          : {
              events: [],
              scannedBytes: 0,
              fileBytes: 0,
              truncatedByScanLimit: false,
            },
      ),
  );

  server.registerTool(
    'skills_validate',
    {
      title: 'Validate Nexowire skill manifests',
      description:
        'Validate every installed SKILL.md manifest and report invalid directories without loading workflow bodies into normal tool context.',
      inputSchema: {},
    },
    async () => toolResult(await ctx.skills.validate()),
  );

  server.registerTool(
    'skills_list',
    {
      title: 'List Nexowire skills',
      description:
        'List lightweight machine-readable skill manifests. Optionally evaluate whether each skill is runnable on one exact online Nexowire device.',
      inputSchema: {
        device_id: z.string().min(1).max(128).optional(),
      },
    },
    async ({ device_id }) => {
      if (!device_id) {
        return toolResult({ skills: await ctx.skills.list() });
      }

      const targetId = await resolveDevice(ctx, device_id);
      const target = (await routingEntries(ctx)).find(
        (device) => device.id === targetId,
      );
      if (!target) {
        throw new McpTargetAuthorizationError(
          'Requested Nexowire device is unavailable for skill evaluation.',
        );
      }

      return toolResult({
        device: {
          id: target.id,
          name: target.name,
          platform: target.platform ?? null,
          capabilities: target.capabilities,
        },
        skills: await ctx.skills.list({
          capabilities: target.capabilities,
          ...(target.platform
            ? { platform: target.platform as NodeJS.Platform }
            : {}),
        }),
      });
    },
  );

  server.registerTool(
    'skill_read',
    {
      title: 'Read Nexowire skill',
      description:
        'Load one reusable computer-control workflow by name. Optionally include runnability evaluation for one exact online device.',
      inputSchema: {
        name: z.string().min(1).max(128),
        device_id: z.string().min(1).max(128).optional(),
      },
    },
    async ({ name, device_id }) => {
      const loaded = await ctx.skills.load(name);
      if (!device_id) {
        return toolResult({
          name,
          manifest: loaded.manifest,
          markdown: loaded.markdown,
        });
      }

      const targetId = await resolveDevice(ctx, device_id);
      const target = (await routingEntries(ctx)).find(
        (device) => device.id === targetId,
      );
      if (!target) {
        throw new McpTargetAuthorizationError(
          'Requested Nexowire device is unavailable for skill evaluation.',
        );
      }

      const evaluated = (
        await ctx.skills.list({
          capabilities: target.capabilities,
          ...(target.platform
            ? { platform: target.platform as NodeJS.Platform }
            : {}),
        })
      ).find((skill) => skill.name === loaded.manifest.name);

      return toolResult({
        name,
        manifest: {
          ...loaded.manifest,
          ...(evaluated?.evaluation
            ? { evaluation: evaluated.evaluation }
            : {}),
        },
        device: {
          id: target.id,
          name: target.name,
          platform: target.platform ?? null,
        },
        markdown: loaded.markdown,
      });
    },
  );

  return server;
}
