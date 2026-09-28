import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { AuditLog } from '../audit/log.js';
import type { ProviderRegistry } from '../core/provider-registry.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { WorkspaceStore } from '../workspace/store.js';

export interface McpContext {
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
      },
    },
    async ({ device_id, provider_id, path, encoding, max_bytes }) =>
      await execute(
        ctx,
        'files.read',
        {
          path,
          ...(encoding ? { encoding } : {}),
          ...(max_bytes ? { max_bytes } : {}),
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
      },
    },
    async ({ device_id, provider_id, paths, encoding, max_bytes_each, max_total_bytes }) =>
      await execute(
        ctx,
        'files.read_many',
        {
          paths,
          ...(encoding ? { encoding } : {}),
          ...(max_bytes_each ? { max_bytes_each } : {}),
          ...(max_total_bytes ? { max_total_bytes } : {}),
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
