import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { AuditLog } from '../audit/log.js';
import type { AgentBroker } from '../core/agent-broker.js';
import type { ProviderRegistry } from '../core/provider-registry.js';
import type { DeviceAliasStore } from '../devices/alias-store.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { WorkspaceStore } from '../workspace/store.js';

export interface McpContext {
  broker: AgentBroker;
  providers: ProviderRegistry;
  aliases?: DeviceAliasStore;
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
  aliases: DeviceAliasStore | undefined,
  requested?: string,
): Promise<string> {
  const targets = (await providers.listTargets()).filter((target) => target.online);
  const uniqueIds = [...new Set(targets.map((target) => target.id))];

  if (requested) {
    if (uniqueIds.includes(requested)) return requested;
    const aliased = await aliases?.resolve(requested);
    if (aliased) {
      if (!uniqueIds.includes(aliased)) {
        throw new Error(
          `Nexowire device alias "${requested}" resolves to offline device "${aliased}".`,
        );
      }
      return aliased;
    }
    return requested;
  }

  if (uniqueIds.length === 1 && uniqueIds[0]) return uniqueIds[0];
  throw new Error(
    uniqueIds.length === 0
      ? 'No Nexowire devices are online.'
      : 'Multiple Nexowire devices are online; device_id or a device alias is required.',
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
    targetId = await resolveDevice(ctx.providers, ctx.aliases, deviceId);
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
        'List online Nexowire native targets with capabilities and persistent aliases.',
      inputSchema: {},
    },
    async () => {
      const targets = await ctx.providers.listTargets();
      const devices = await Promise.all(
        targets.map(async (target) => ({
          ...target,
          aliases: ctx.aliases
            ? await ctx.aliases.aliasesForDevice(target.id)
            : [],
        })),
      );
      return toolResult({ devices });
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
    async () =>
      toolResult({
        aliases: ctx.aliases ? await ctx.aliases.list() : [],
      }),
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
      const targets = await ctx.providers.listTargets();
      if (!targets.some((target) => target.online && target.id === device_id)) {
        return toolResult(
          {
            ok: false,
            error: `Cannot alias offline or unknown device "${device_id}".`,
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
        'Set one exact environment variable in process, user, or machine scope and verify the stored value. User/machine changes apply to newly created processes.',
      inputSchema: {
        ...targetFields,
        scope: z.enum(['process', 'user', 'machine']).optional(),
        name: z.string().min(1).max(1024),
        value: z.string().max(32_767),
      },
    },
    async ({ device_id, provider_id, scope, name, value }) =>
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
      ),
  );

  server.registerTool(
    'windows_environment_delete',
    {
      title: 'Delete Windows environment variable',
      description:
        'Delete one exact environment variable from process, user, or machine scope and verify removal.',
      inputSchema: {
        ...targetFields,
        scope: z.enum(['process', 'user', 'machine']).optional(),
        name: z.string().min(1).max(1024),
      },
    },
    async ({ device_id, provider_id, scope, name }) =>
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
      description:
        'Start a long-running or interactive process and return a reusable session id. durable=true moves pipe ownership into a first-party detached host so stdin/stdout can be reattached after native-agent restart.',
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
