import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AuditLog } from '../src/audit/log.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentBroker } from '../src/core/agent-broker.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { DeviceAliasStore } from '../src/devices/alias-store.js';
import { IdempotencyStore } from '../src/operations/idempotency-store.js';
import { CapabilityPolicyStore } from '../src/security/capability-policy.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { createNexowireMcpServer } from '../src/mcp/create-server.js';
import { AgentProvider } from '../src/providers/agent-provider.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { WorkspaceStore } from '../src/workspace/store.js';

test('MCP request reaches a native agent through the provider registry', async (t) => {
  const http = createServer();
  const broker = new AgentBroker();
  const wss = attachAgentWebSocketServer(http, broker, 'integration-token');
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));

  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-mcp-'));
  const providers = new ProviderRegistry();
  providers.register(new AgentProvider(broker));
  const audit = new AuditLog(path.join(stateDir, 'audit.jsonl'));
  const aliases = new DeviceAliasStore(stateDir);
  const idempotency = new IdempotencyStore(stateDir);
  const policies = new CapabilityPolicyStore(stateDir);
  await Promise.all([
    aliases.initialize(),
    idempotency.initialize(),
    policies.initialize(),
  ]);

  const mcp = createNexowireMcpServer({
    broker,
    providers,
    aliases,
    idempotency,
    policies,
    audit,
    workspaces: new WorkspaceStore(stateDir),
    skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
  });
  const client = new Client({ name: 'nexowire-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    mcp.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  t.after(async () => {
    await client.close();
    await mcp.close();
    for (const ws of wss.clients) ws.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const agent = new WebSocket(`ws://127.0.0.1:${address.port}/agent`, {
    headers: { Authorization: 'Bearer integration-token' },
  });
  await new Promise<void>((resolve, reject) => {
    agent.once('open', resolve);
    agent.once('error', reject);
  });

  agent.send(JSON.stringify({
    type: 'hello',
    protocolVersion: AGENT_PROTOCOL_VERSION,
    instanceId: '33333333-3333-4333-8333-333333333333',
    device: {
      id: 'mcp-device',
      name: 'MCP Integration Device',
      platform: process.platform,
      arch: process.arch,
      agentVersion: 'integration-test',
      capabilities: ['machine.snapshot', 'files.write', 'windows.screenshot', 'browser.screenshot', 'browser.visual.verify'],
    },
  }));

  let filesWriteRequests = 0;
  agent.on('message', (raw) => {
    const request = JSON.parse(raw.toString()) as {
      type: string;
      requestId: string;
      capability: string;
    };
    if (request.type !== 'request') return;
    if (request.capability === 'files.write') filesWriteRequests++;
    const data =
      request.capability === 'windows.screenshot'
        ? {
            data: {
              source: 'primary_screen',
              hwnd: null,
              windowVisible: null,
              captureRect: { x: 0, y: 0, width: 1, height: 1 },
              width: 1,
              height: 1,
              scaled: false,
              scale: 1,
              mimeType: 'image/png',
              bytes: 68,
              sha256: '0'.repeat(64),
              capturedAt: new Date().toISOString(),
              base64:
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl4wS8AAAAASUVORK5CYII=',
            },
          }
        : request.capability === 'browser.screenshot'
          ? {
              data: {
                sessionId: '11111111-1111-4111-8111-111111111111',
                targetId: 'page-1',
                width: 1,
                height: 1,
                mimeType: 'image/png',
                bytes: 68,
                sha256: '1'.repeat(64),
                capturedAt: new Date().toISOString(),
                base64:
                  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl4wS8AAAAASUVORK5CYII=',
              },
            }
          : request.capability === 'browser.visual.verify'
            ? {
                data: {
                  sessionId: '11111111-1111-4111-8111-111111111111',
                  targetId: 'page-1',
                  selector: '#status',
                  verified: true,
                  element: {
                    tag: 'div',
                    visible: true,
                    enabled: true,
                    hittable: true,
                  },
                  expectations: [
                    {
                      name: 'text',
                      expected: 'ready',
                      actual: 'ready',
                      passed: true,
                    },
                  ],
                  screenshot: {
                    width: 1,
                    height: 1,
                    mimeType: 'image/png',
                    bytes: 68,
                    sha256: '2'.repeat(64),
                    capturedAt: new Date().toISOString(),
                    base64:
                      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl4wS8AAAAASUVORK5CYII=',
                  },
                },
              }
            : {
            data: {
              hostname: 'mcp-e2e-host',
              capability: request.capability,
            },
          };
    agent.send(JSON.stringify({
      type: 'response',
      requestId: request.requestId,
      ok: true,
      data,
    }));
  });

  for (let i = 0; i < 100 && !broker.has('mcp-device'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(broker.has('mcp-device'), true);

  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'policy_profile_list'));
  assert.ok(tools.tools.some((tool) => tool.name === 'policy_profile_set'));
  assert.ok(tools.tools.some((tool) => tool.name === 'policy_profile_delete'));
  assert.ok(tools.tools.some((tool) => tool.name === 'policy_device_bind'));
  assert.ok(tools.tools.some((tool) => tool.name === 'policy_device_unbind'));
  assert.ok(tools.tools.some((tool) => tool.name === 'policy_device_check'));
  assert.ok(tools.tools.some((tool) => tool.name === 'operations_idempotency_list'));
  assert.ok(tools.tools.some((tool) => tool.name === 'device_alias_list'));
  assert.ok(tools.tools.some((tool) => tool.name === 'device_alias_set'));
  assert.ok(tools.tools.some((tool) => tool.name === 'device_alias_delete'));
  assert.ok(tools.tools.some((tool) => tool.name === 'device_route'));
  assert.ok(tools.tools.some((tool) => tool.name === 'device_route_policy_list'));
  assert.ok(tools.tools.some((tool) => tool.name === 'device_route_policy_set'));
  assert.ok(tools.tools.some((tool) => tool.name === 'device_route_policy_delete'));
  assert.ok(tools.tools.some((tool) => tool.name === 'device_route_policy_resolve'));
  assert.ok(tools.tools.some((tool) => tool.name === 'audit_query'));
  assert.ok(tools.tools.some((tool) => tool.name === 'machine_snapshot'));
  assert.ok(tools.tools.some((tool) => tool.name === 'machine_health'));
  assert.ok(tools.tools.some((tool) => tool.name === 'network_dns_resolve'));
  assert.ok(tools.tools.some((tool) => tool.name === 'network_tcp_probe'));
  assert.ok(tools.tools.some((tool) => tool.name === 'network_http_probe'));
  assert.ok(tools.tools.some((tool) => tool.name === 'events_read'));
  assert.ok(tools.tools.some((tool) => tool.name === 'process_start'));
  assert.ok(tools.tools.some((tool) => tool.name === 'process_prune'));
  assert.ok(tools.tools.some((tool) => tool.name === 'file_patch'));
  assert.ok(tools.tools.some((tool) => tool.name === 'file_hash'));
  assert.ok(tools.tools.some((tool) => tool.name === 'workspace_detect'));
  assert.ok(tools.tools.some((tool) => tool.name === 'workspace_run_checks'));
  assert.ok(tools.tools.some((tool) => tool.name === 'task_run_graph'));
  assert.ok(tools.tools.some((tool) => tool.name === 'task_graph_list'));
  assert.ok(tools.tools.some((tool) => tool.name === 'task_graph_get'));
  assert.ok(tools.tools.some((tool) => tool.name === 'task_graph_prune'));
  assert.ok(tools.tools.some((tool) => tool.name === 'runbook_run'));
  assert.ok(tools.tools.some((tool) => tool.name === 'runbook_list'));
  assert.ok(tools.tools.some((tool) => tool.name === 'runbook_get'));
  assert.ok(tools.tools.some((tool) => tool.name === 'runbook_prune'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_window_list'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_window_focus'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_screenshot'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_clipboard_read'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_clipboard_write'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_clipboard_clear'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_keyboard_type'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_keyboard_hotkey'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_accessibility_tree'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_accessibility_find'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_accessibility_invoke'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_accessibility_set_value'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_pointer_position'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_pointer_move'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_pointer_click'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_pointer_scroll'));
  assert.ok(tools.tools.some((tool) => tool.name === 'browser_session_start'));
  assert.ok(tools.tools.some((tool) => tool.name === 'browser_session_list'));
  assert.ok(tools.tools.some((tool) => tool.name === 'browser_session_stop'));
  assert.ok(tools.tools.some((tool) => tool.name === 'browser_tabs'));
  assert.ok(tools.tools.some((tool) => tool.name === 'browser_navigate'));
  assert.ok(tools.tools.some((tool) => tool.name === 'browser_snapshot'));
  assert.ok(tools.tools.some((tool) => tool.name === 'browser_click'));
  assert.ok(tools.tools.some((tool) => tool.name === 'browser_set_value'));
  assert.ok(tools.tools.some((tool) => tool.name === 'browser_screenshot'));
  assert.ok(tools.tools.some((tool) => tool.name === 'browser_visual_verify'));
  assert.ok(tools.tools.some((tool) => tool.name === 'verify_assertions'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_processes'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_registry_read'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_eventlog_query'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_registry_set'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_task_control'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_firewall_control'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_environment_list'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_environment_read'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_environment_set'));
  assert.ok(tools.tools.some((tool) => tool.name === 'windows_environment_delete'));

  const firstIdempotentWrite = await client.callTool({
    name: 'file_write',
    arguments: {
      device_id: 'mcp-device',
      path: 'idempotent.txt',
      content: 'hello',
      mode: 'overwrite',
      idempotency_key: 'write-idempotency-1',
    },
  });
  assert.equal(
    'isError' in firstIdempotentWrite
      ? firstIdempotentWrite.isError
      : false,
    false,
  );
  assert.equal(filesWriteRequests, 1);

  const replayedIdempotentWrite = await client.callTool({
    name: 'file_write',
    arguments: {
      device_id: 'mcp-device',
      path: 'idempotent.txt',
      content: 'hello',
      mode: 'overwrite',
      idempotency_key: 'write-idempotency-1',
    },
  });
  assert.equal(
    'isError' in replayedIdempotentWrite
      ? replayedIdempotentWrite.isError
      : false,
    false,
  );
  assert.equal(filesWriteRequests, 1);
  const replayedWriteStructured =
    replayedIdempotentWrite.structuredContent as {
      idempotency?: {
        replayed?: boolean;
        resultSource?: string;
      };
    };
  assert.equal(replayedWriteStructured.idempotency?.replayed, true);
  assert.equal(
    replayedWriteStructured.idempotency?.resultSource,
    'memory',
  );

  const reusedKeyDifferentPayload = await client.callTool({
    name: 'file_write',
    arguments: {
      device_id: 'mcp-device',
      path: 'idempotent.txt',
      content: 'different',
      mode: 'overwrite',
      idempotency_key: 'write-idempotency-1',
    },
  });
  assert.equal(
    'isError' in reusedKeyDifferentPayload
      ? reusedKeyDifferentPayload.isError
      : false,
    true,
  );
  assert.equal(filesWriteRequests, 1);

  const unsafeAppendIdempotency = await client.callTool({
    name: 'file_write',
    arguments: {
      device_id: 'mcp-device',
      path: 'append.txt',
      content: 'x',
      mode: 'append',
      idempotency_key: 'append-idempotency-1',
    },
  });
  assert.equal(
    'isError' in unsafeAppendIdempotency
      ? unsafeAppendIdempotency.isError
      : false,
    true,
  );
  assert.equal(filesWriteRequests, 1);

  const operationRecords = await client.callTool({
    name: 'operations_idempotency_list',
    arguments: { limit: 10 },
  });
  const operationRecordsStructured =
    operationRecords.structuredContent as {
      records?: Array<{
        key?: string;
        status?: string;
        fingerprint?: string;
      }>;
    };
  const writeRecord = operationRecordsStructured.records?.find(
    (record) => record.key === 'write-idempotency-1',
  );
  assert.equal(writeRecord?.status, 'succeeded');
  assert.match(writeRecord?.fingerprint ?? '', /^[a-f0-9]{64}$/);

  const aliasSet = await client.callTool({
    name: 'device_alias_set',
    arguments: {
      alias: 'main-pc',
      device_id: 'mcp-device',
    },
  });
  assert.equal('isError' in aliasSet ? aliasSet.isError : false, false);

  const routeResult = await client.callTool({
    name: 'device_route',
    arguments: {
      device_id: 'MAIN-PC',
      required_capabilities: ['browser.screenshot'],
    },
  });
  assert.equal(
    'isError' in routeResult ? routeResult.isError : false,
    false,
  );
  const routeStructured = routeResult.structuredContent as {
    selected?: {
      id?: string;
      online?: boolean;
      aliases?: string[];
    } | null;
    ambiguous?: boolean;
    requestedAlias?: string;
    resolvedDeviceId?: string;
  };
  assert.equal(routeStructured.selected?.id, 'mcp-device');
  assert.equal(routeStructured.selected?.online, true);
  assert.deepEqual(routeStructured.selected?.aliases, ['main-pc']);
  assert.equal(routeStructured.ambiguous, false);
  assert.equal(routeStructured.requestedAlias, 'MAIN-PC');
  assert.equal(routeStructured.resolvedDeviceId, 'mcp-device');

  const aliasResult = await client.callTool({
    name: 'machine_snapshot',
    arguments: { device_id: 'MAIN-PC' },
  });
  assert.equal('isError' in aliasResult ? aliasResult.isError : false, false);
  const aliasStructured = aliasResult.structuredContent as {
    data?: { hostname?: string };
    meta?: { targetId?: string };
  };
  assert.equal(aliasStructured.data?.hostname, 'mcp-e2e-host');
  assert.equal(aliasStructured.meta?.targetId, 'mcp-device');

  const result = await client.callTool({
    name: 'machine_snapshot',
    arguments: { device_id: 'mcp-device' },
  });

  assert.equal('isError' in result ? result.isError : false, false);
  assert.ok('structuredContent' in result);
  const structured = result.structuredContent as {
    ok?: boolean;
    data?: { hostname?: string; capability?: string };
    meta?: { providerId?: string; targetId?: string; requestId?: string };
  };
  assert.equal(structured.ok, true);
  assert.equal(structured.data?.hostname, 'mcp-e2e-host');
  assert.equal(structured.data?.capability, 'machine.snapshot');
  assert.equal(structured.meta?.providerId, 'native-agent');
  assert.equal(structured.meta?.targetId, 'mcp-device');
  assert.match(structured.meta?.requestId ?? '', /^[0-9a-f-]{36}$/i);

  const screenshotResult = await client.callTool({
    name: 'windows_screenshot',
    arguments: {
      device_id: 'mcp-device',
      source: 'primary_screen',
      max_width: 640,
      max_height: 480,
    },
  });
  assert.equal('isError' in screenshotResult ? screenshotResult.isError : false, false);
  const screenshotContent = (screenshotResult.content ?? []) as Array<{
    type: string;
    mimeType?: string;
    data?: string;
  }>;
  assert.ok(
    screenshotContent.some(
      (part) =>
        part.type === 'image' &&
        part.mimeType === 'image/png' &&
        typeof part.data === 'string' &&
        part.data.length > 0,
    ),
  );
  const screenshotStructured = screenshotResult.structuredContent as {
    data?: Record<string, unknown>;
  };
  assert.equal('base64' in (screenshotStructured.data ?? {}), false);
  assert.equal(screenshotStructured.data?.mimeType, 'image/png');

  const browserScreenshotResult = await client.callTool({
    name: 'browser_screenshot',
    arguments: {
      device_id: 'mcp-device',
      session_id: '11111111-1111-4111-8111-111111111111',
      target_id: 'page-1',
    },
  });
  assert.equal(
    'isError' in browserScreenshotResult
      ? browserScreenshotResult.isError
      : false,
    false,
  );
  const browserScreenshotContent =
    (browserScreenshotResult.content ?? []) as Array<{
      type: string;
      mimeType?: string;
      data?: string;
    }>;
  assert.ok(
    browserScreenshotContent.some(
      (part) =>
        part.type === 'image' &&
        part.mimeType === 'image/png' &&
        typeof part.data === 'string' &&
        part.data.length > 0,
    ),
  );
  const browserScreenshotStructured =
    browserScreenshotResult.structuredContent as {
      data?: Record<string, unknown>;
    };
  assert.equal(
    'base64' in (browserScreenshotStructured.data ?? {}),
    false,
  );
  assert.equal(
    browserScreenshotStructured.data?.mimeType,
    'image/png',
  );

  const visualVerifyResult = await client.callTool({
    name: 'browser_visual_verify',
    arguments: {
      device_id: 'mcp-device',
      session_id: '11111111-1111-4111-8111-111111111111',
      target_id: 'page-1',
      selector: '#status',
      expected_text: 'ready',
      text_mode: 'exact',
    },
  });
  assert.equal(
    'isError' in visualVerifyResult
      ? visualVerifyResult.isError
      : false,
    false,
  );
  const visualVerifyContent =
    (visualVerifyResult.content ?? []) as Array<{
      type: string;
      mimeType?: string;
      data?: string;
    }>;
  assert.ok(
    visualVerifyContent.some(
      (part) =>
        part.type === 'image' &&
        part.mimeType === 'image/png' &&
        typeof part.data === 'string' &&
        part.data.length > 0,
    ),
  );
  const visualVerifyStructured =
    visualVerifyResult.structuredContent as {
      data?: {
        verified?: boolean;
        screenshot?: Record<string, unknown>;
      };
    };
  assert.equal(visualVerifyStructured.data?.verified, true);
  assert.equal(
    'base64' in (visualVerifyStructured.data?.screenshot ?? {}),
    false,
  );
  assert.equal(
    visualVerifyStructured.data?.screenshot?.mimeType,
    'image/png',
  );

  const auditQueryResult = await client.callTool({
    name: 'audit_query',
    arguments: {
      operation_id: structured.meta?.requestId,
      capability: 'machine.snapshot',
      limit: 10,
    },
  });
  assert.equal(
    'isError' in auditQueryResult ? auditQueryResult.isError : false,
    false,
  );
  const auditQueryStructured =
    auditQueryResult.structuredContent as {
      events?: Array<{
        operationId?: string;
        status?: string;
        capability?: string;
      }>;
      scannedBytes?: number;
      fileBytes?: number;
    };
  assert.ok((auditQueryStructured.events?.length ?? 0) >= 2);
  assert.ok(
    auditQueryStructured.events?.every(
      (event) =>
        event.operationId === structured.meta?.requestId &&
        event.capability === 'machine.snapshot',
    ),
  );

  const auditResult = await client.callTool({
    name: 'audit_recent',
    arguments: { limit: 10 },
  });
  assert.ok('structuredContent' in auditResult);
  const auditContent = auditResult.structuredContent as {
    events?: Array<{ operationId: string; status: string; capability: string }>;
  };
  const operationEvents = (auditContent.events ?? []).filter(
    (event) => event.operationId === structured.meta?.requestId,
  );
  assert.deepEqual(
    operationEvents.map((event) => event.status).sort(),
    ['started', 'succeeded'],
  );
  assert.ok(operationEvents.every((event) => event.capability === 'machine.snapshot'));

  const policyProfile = await client.callTool({
    name: 'policy_profile_set',
    arguments: {
      name: 'snapshot-denied',
      allow: ['*'],
      deny: ['machine.snapshot'],
    },
  });
  assert.equal(
    'isError' in policyProfile ? policyProfile.isError : false,
    false,
  );

  const policyBinding = await client.callTool({
    name: 'policy_device_bind',
    arguments: {
      device: 'MAIN-PC',
      profile: 'snapshot-denied',
    },
  });
  assert.equal(
    'isError' in policyBinding ? policyBinding.isError : false,
    false,
  );

  const policyCheck = await client.callTool({
    name: 'policy_device_check',
    arguments: {
      device: 'mcp-device',
      capability: 'machine.snapshot',
    },
  });
  const policyCheckStructured = policyCheck.structuredContent as {
    allowed?: boolean;
    bound?: boolean;
    profile?: string;
  };
  assert.equal(policyCheckStructured.allowed, false);
  assert.equal(policyCheckStructured.bound, true);
  assert.equal(policyCheckStructured.profile, 'snapshot-denied');

  const deniedByPolicy = await client.callTool({
    name: 'machine_snapshot',
    arguments: { device_id: 'mcp-device' },
  });
  assert.equal(
    'isError' in deniedByPolicy ? deniedByPolicy.isError : false,
    true,
  );
  const deniedStructured = deniedByPolicy.structuredContent as {
    error?: { code?: string };
  };
  assert.equal(deniedStructured.error?.code, 'CAPABILITY_DENIED');

  agent.close();
});
