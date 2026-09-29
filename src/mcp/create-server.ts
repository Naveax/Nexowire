import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { AuditLog } from '../audit/log.js';
import type { AgentBroker } from '../core/agent-broker.js';
import type { ProviderRegistry } from '../core/provider-registry.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { WorkspaceStore } from '../workspace/store.js';

export interface McpContext {
  broker: AgentBroker;
  providers: ProviderRegistry;
  audit?: AuditLog;
  workspaces: WorkspaceStore;
  skills: SkillRegistry;
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

async function resolveDevice(
  providers: ProviderRegistry,
  requested?: string,
): Promise<string> {
  if (requested) return requested;
  const targets = (await providers.listTargets()).filter((target) => target.online);
  const uniqueIds = [...new Set(targets.map((target) => target.id))];
  if (uniqueIds.length === 1 && uniqueIds[0]) return uniqueIds[0];
  throw new Error(
    uniqueIds.length === 0
      ? 'No Nexowire devices are online.'
      : 'Multiple Nexowire devices are online; device_id is required.',
  );
}

async function execute(
  ctx: McpContext,
  capability: string,
  input: unknown,
  deviceId?: string,
  providerId?: string,
  timeoutMs?: number,
) {
  const operationId = randomUUID();
  const started = performance.now();
  let targetId: string | undefined;
  try {
    targetId = await resolveDevice(ctx.providers, deviceId);
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
    return toolResult(result, !result.ok);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.audit?.write({
      operationId,
      status: 'failed',
      capability,
      ...(targetId ? { targetId } : {}),
      ...(providerId ? { providerId } : {}),
      durationMs: Math.round(performance.now() - started),
      errorCode:
        typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'EXECUTION_FAILED',
      message,
    });
    return toolResult({ ok: false, operationId, error: message }, true);
  }
}

const targetFields = {
  device_id: z.string().min(1).max(128).optional(),
  provider_id: z.string().min(1).max(128).optional(),
};

export function createNexowireMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: 'nexowire', version: '0.1.0-dev.1' },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    'devices_list',
    {
      title: 'List Nexowire devices',
      description:
        'List online targets across Nexowire providers with their capabilities.',
      inputSchema: {},
    },
    async () => toolResult({ devices: await ctx.providers.listTargets() }),
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
        'Query recent Windows events by log, provider, level, time window, and maximum result count.',
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
        'Create or update one exact registry value and verify the stored value type/content.',
      inputSchema: {
        ...targetFields,
        hive: z.enum(['HKCU', 'HKLM', 'HKCR', 'HKU', 'HKCC']),
        path: z.string().min(1).max(4096),
        name: z.string().min(1).max(1024),
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
      ),
  );

  server.registerTool(
    'windows_registry_delete',
    {
      title: 'Delete Windows registry value or key',
      description:
        'Delete one exact registry value, or delete one non-root key. Recursive key deletion must be explicitly enabled.',
      inputSchema: {
        ...targetFields,
        hive: z.enum(['HKCU', 'HKLM', 'HKCR', 'HKU', 'HKCC']),
        path: z.string().min(1).max(4096),
        name: z.string().min(1).max(1024).optional(),
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
    }) =>
      await execute(
        ctx,
        'windows.registry.delete',
        {
          hive,
          path,
          ...(name ? { name } : {}),
          ...(recursive !== undefined ? { recursive } : {}),
        },
        device_id,
        provider_id,
        45_000,
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
      description: 'Start a long-running or interactive process and return a reusable session id.',
      inputSchema: {
        ...targetFields,
        command: z.string().min(1).max(200_000),
        shell: z.enum(['pwsh', 'powershell', 'cmd', 'bash', 'sh']).optional(),
        cwd: z.string().max(4096).optional(),
        name: z.string().min(1).max(128).optional(),
        max_buffer_bytes: z.number().int().min(65_536).max(16_777_216).optional(),
      },
    },
    async ({ device_id, provider_id, command, shell, cwd, name, max_buffer_bytes }) =>
      await execute(
        ctx,
        'process.start',
        {
          command,
          ...(shell ? { shell } : {}),
          ...(cwd ? { cwd } : {}),
          ...(name ? { name } : {}),
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
        path: z.string().min(1).max(4096),
        recursive: z.boolean().optional(),
      },
    },
    async ({ device_id, provider_id, path, recursive }) =>
      await execute(
        ctx,
        'files.mkdir',
        { path, ...(recursive !== undefined ? { recursive } : {}) },
        device_id,
        provider_id,
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
        'Apply exact text replacements with occurrence-count and optional SHA-256 stale-read checks before writing.',
      inputSchema: {
        ...targetFields,
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
    async ({ device_id, provider_id, path, operations, max_bytes, expected_sha256 }) =>
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
    'skills_list',
    {
      title: 'List Nexowire skills',
      description:
        'List lightweight skill metadata. Read a skill only when its workflow is relevant.',
      inputSchema: {},
    },
    async () => toolResult({ skills: await ctx.skills.list() }),
  );

  server.registerTool(
    'skill_read',
    {
      title: 'Read Nexowire skill',
      description:
        'Load one reusable computer-control workflow by name when needed.',
      inputSchema: { name: z.string().min(1).max(128) },
    },
    async ({ name }) => toolResult({ name, markdown: await ctx.skills.read(name) }),
  );

  return server;
}
