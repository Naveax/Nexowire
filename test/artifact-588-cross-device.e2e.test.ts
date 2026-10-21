import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentBroker } from '../src/core/agent-broker.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { AgentProvider } from '../src/providers/agent-provider.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { createNexowireMcpServer } from '../src/mcp/create-server.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';

test('one MCP start uses two real sandboxed WebSocket Agents and durable status, hash and atomic publish', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-597-e2e-'));
  const srcRoot = path.join(root, 'source'), dstRoot = path.join(root, 'destination');
  await fs.mkdir(srcRoot); await fs.mkdir(dstRoot);
  const content = Buffer.alloc(221 * 1024 + 17);
  for (let n = 0; n < content.length; n++) content[n] = (n * 29 + 91) & 255;
  const srcFile = path.join(srcRoot, 'sample.bin');
  const dstFile = path.join(dstRoot, 'sample.bin');
  await fs.writeFile(srcFile, content);
  const http = createServer(), broker = new AgentBroker();
  const wss = attachAgentWebSocketServer(http, broker, 'synthetic-only-token');
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  const addr = http.address();
  if (!addr || typeof addr !== 'object') throw Error('No loopback address');
  const port = addr.port;
  const providers = new ProviderRegistry();
  providers.register(new AgentProvider(broker));
  const workspaces = new WorkspaceStore(path.join(root, 'hub-state'));
  // Staging-only independent authority emulator: NOT a trusted production
  // CAS service. Both sessions share exactly one monotonic fixture.
  const epochs = new Map<string, number>();
  const artifactTransferAuthority = {
    acquire: async (job: { id: string }, _mode: 'new' | 'resume') => {
      const next = (epochs.get(job.id) ?? 0) + 1;
      epochs.set(job.id, next);
      return { epoch: next, token: 'staging-only-' + job.id + '-' + next.toString().padStart(10, '0') };
    },
    assertCurrent: async (job: { id: string }, proof: { epoch: number; token: string }) => {
      if (epochs.get(job.id) !== proof.epoch ||
          proof.token !== 'staging-only-' + job.id + '-' + proof.epoch.toString().padStart(10, '0')) {
        throw new Error('STALE_EXTERNAL_FENCE');
      }
    },
  };
  const artifactTransferCoreGrants = {
    assertCurrent: async (job: { accountId: string; projectId: string;
      sourceDeviceId: string; targetDeviceId: string }) => {
      // TEST-ONLY CURRENT CORE GRANT emulator. No live owner enrollment.
      if (job.accountId !== 'account:synthetic-e2e-account' || job.projectId !== 'Nexowire' ||
          job.sourceDeviceId !== 'source' || job.targetDeviceId !== 'destination') {
        throw Error('CORE_OWNER_SCOPE_REVOKED');
      }
    },
  };
  let sourceCount = 0, destCount = 0, publishCount = 0;
  // Simulated fenced Native writer, NOT Agent 1.0.5's actual files.write.
  const artifactTransferNativeWriter = {
    writeFenced: async (job: { id: string; stagePath: string },
      env: { requestId: string; epoch: number; token: string; offset: number;
        length: number; sha256: string }, body: string, first: boolean) => {
      if (epochs.get(job.id) !== env.epoch ||
          env.token !== 'staging-only-' + job.id + '-' +
            env.epoch.toString().padStart(10, '0')) throw Error('STALE_AGENT_WRITE_FENCE');
      const bytes = Buffer.from(body, 'base64');
      if (bytes.length !== env.length ||
          createHash('sha256').update(bytes).digest('hex') !== env.sha256) {
        throw Error('BAD_CHUNK_SHA');
      }
      const current = await fs.stat(job.stagePath).catch(() => null);
      if (first ? current !== null : current?.size !== env.offset) {
        throw Error('ATOMIC_STAGE_OFFSET_CAS_DENIED');
      }
      const written = await executeCapability('files.write', {
        path: job.stagePath, content: body, encoding: 'base64',
        mode: first ? 'create' : 'write_at',
        ...(!first ? { offset_bytes: env.offset } : {}), create_parents: false,
      }, new PathPolicy([dstRoot])) as { data: { bytesWritten: number } };
      if (written.data.bytesWritten !== env.length) throw Error('SHORT_WRITE');
      destCount++;
      return { requestId: env.requestId, epoch: env.epoch,
        offset: env.offset, length: env.length, sha256: env.sha256 };
    },
    publishFenced: async (job: { id: string; stagePath: string; targetPath: string },
      epoch: number, token: string) => {
      if (epochs.get(job.id) !== epoch ||
          token !== 'staging-only-' + job.id + '-' + epoch.toString().padStart(10, '0')) {
        throw Error('STALE_AGENT_PUBLISH_FENCE');
      }
      await executeCapability('files.move', {
        source: job.stagePath, destination: job.targetPath, overwrite: false,
        recursive: false, atomic_no_overwrite: true, create_parents: false,
      }, new PathPolicy([dstRoot]));
      publishCount++;
    },
  };
  const server = createNexowireMcpServer({
    broker, providers, workspaces, artifactTransferAuthority,
    artifactTransferCoreGrants, artifactTransferNativeWriter,
    skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
    toolAuthorization: { kind: 'control-plane', scope: 'mcp',
      accountId: 'synthetic-e2e-account', role: 'admin',
      allowedDeviceIds: ['source', 'destination'] },
  });
  const client = new Client({ name: 'qa-597-e2e', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const sockets: WebSocket[] = [];
  const counts = { reads: 0, writes: 0, atomicMoves: 0 };
  let pauseSourceReads = false;
  let readHeld = false;
  let signalReadEntered!: () => void;
  let releaseSourceRead!: () => void;
  const readEntered = new Promise<void>(resolve => { signalReadEntered = resolve; });
  const readReleased = new Promise<void>(resolve => { releaseSourceRead = resolve; });
  t.after(async () => {
    await client.close();
    await server.close();
    for (const socket of sockets) socket.close();
    for (const socket of wss.clients) socket.close();
    await new Promise<void>(done => http.close(() => done()));
    await fs.rm(root, { force: true, recursive: true });
  });
  async function connect(name: string, allowedRoot: string, capabilities: string[]) {
    const socket = new WebSocket('ws://127.0.0.1:' + port + '/agent', {
      headers: { Authorization: 'Bearer synthetic-only-token' },
    });
    sockets.push(socket);
    await new Promise<void>((res, rej) => { socket.once('open', res); socket.once('error', rej); });
    socket.on('message', data => {
      const msg = JSON.parse(data.toString()) as {
        type: string; requestId: string; capability: string; input: unknown;
      };
      if (msg.type !== 'request') return;
      if (name === 'source' && msg.capability === 'files.read') counts.reads++;
      if (name === 'destination' && msg.capability === 'files.write') counts.writes++;
      if (name === 'destination' && msg.capability === 'files.move' &&
          (msg.input as { atomic_no_overwrite?: boolean })?.atomic_no_overwrite) counts.atomicMoves++;
      void (async () => {
        try {
          if (name === 'source' && msg.capability === 'files.read' &&
              pauseSourceReads && !readHeld) {
            // Deterministic read barrier, not a 120ms race lottery.
            readHeld = true;
            signalReadEntered();
            await readReleased;
          }
          const result = await executeCapability(msg.capability, msg.input, new PathPolicy([allowedRoot]));
          socket.send(JSON.stringify({ type: 'response', requestId: msg.requestId, ok: true, data: result }));
        } catch (error) {
          socket.send(JSON.stringify({ type: 'response', requestId: msg.requestId, ok: false,
            error: { code: 'FIXTURE_DENIED', message: error instanceof Error ? error.message : 'denied' } }));
        }
      })();
    });
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: AGENT_PROTOCOL_VERSION,
      instanceId: name === 'source' ? '11111111-1111-4111-8111-111111111111' :
        '22222222-2222-4222-8222-222222222222',
      device: { id: name, name, platform: process.platform, arch: process.arch,
        agentVersion: 'synthetic-only', capabilities } }));
  }
  await connect('source', srcRoot, ['files.stat', 'files.hash', 'files.read']);
  await connect('destination', dstRoot, ['files.stat', 'files.hash', 'files.read', 'files.write', 'files.move']);
  for (let i = 0; i < 120 && (!broker.has('source') || !broker.has('destination')); i++) {
    await new Promise(done => setTimeout(done, 10));
  }
  assert.ok(broker.has('source') && broker.has('destination'));
  const advertised = (await client.listTools()).tools.map(x => x.name);
  assert.ok(advertised.includes('artifact_bridge_transfer_start'));
  const start = await client.callTool({ name: 'artifact_bridge_transfer_start',
    arguments: { source_device_id: 'source', source_path: srcFile,
      target_device_id: 'destination', target_path: dstFile, project_id: 'Nexowire' } });
  const first = start.structuredContent as {
    ok: boolean; data?: { id: string; state: string }; error?: unknown;
  };
  assert.equal(first.ok, true, JSON.stringify(first));
  const jobId = first.data?.id;
  assert.ok(jobId);
  assert.doesNotMatch(JSON.stringify(start), /contentBase64/);
  let done: { state: string; bytesConfirmed: number; sha256: string } | undefined;
  for (let i = 0; i < 150; i++) {
    const reply = await client.callTool({ name: 'artifact_bridge_transfer_status',
      arguments: { transfer_id: jobId } });
    const val = reply.structuredContent as {ok: boolean; data?: typeof done; error?: unknown};
    assert.equal(val.ok, true, JSON.stringify(val));
    if (val.data?.state === 'COMPLETED') { done = val.data; break; }
    if (['FAILED','MUTATION_UNKNOWN','CANCELLED'].includes(val.data?.state ?? '')) {
      assert.fail('Unexpected transfer terminal state: ' + JSON.stringify(val.data));
    }
    await new Promise(res => setTimeout(res, 30));
  }
  assert.equal(done?.state, 'COMPLETED');
  assert.equal(done.bytesConfirmed, content.length);
  assert.equal(done.sha256, createHash('sha256').update(content).digest('hex'));
  assert.deepEqual(await fs.readFile(dstFile), content);
  assert.equal(counts.reads, 4);
  assert.equal(destCount, 4);
  assert.equal(publishCount, 1);

  // A different principal with both device IDs must not read the durable job
  // created by the original account. A same-account grant missing the target
  // must not trigger any remote source read/write.
  async function restricted(accountId: string, grants: string[]) {
    const mcp = createNexowireMcpServer({
      broker, providers, workspaces, artifactTransferAuthority,
      artifactTransferCoreGrants, artifactTransferNativeWriter, skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
      toolAuthorization: { kind: 'control-plane', scope: 'mcp', accountId,
        role: 'admin', allowedDeviceIds: grants },
    });
    const blocked = new Client({ name: 'restricted-597', version: '1.0.0' });
    const [x, y] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(y), blocked.connect(x)]);
    return { blocked, mcp };
  }
  const foreign = await restricted('synthetic-foreign-account', ['source', 'destination']);
  try {
    const forbidden = await foreign.blocked.callTool({
      name: 'artifact_bridge_transfer_status', arguments: { transfer_id: jobId },
    });
    assert.equal((forbidden.structuredContent as { ok: boolean }).ok, false);
  } finally { await foreign.blocked.close(); await foreign.mcp.close(); }
  const limited = await restricted('synthetic-e2e-account', ['source']);
  try {
    const beforeReads = counts.reads;
    const forbidden = await limited.blocked.callTool({
      name: 'artifact_bridge_transfer_start', arguments: {
        source_device_id: 'source', source_path: srcFile,
        target_device_id: 'destination', target_path: path.join(dstRoot, 'forbidden.bin'),
      },
    });
    assert.equal((forbidden.structuredContent as { ok: boolean }).ok, false);
    assert.equal(counts.reads, beforeReads);
  } finally { await limited.blocked.close(); await limited.mcp.close(); }

  // MCP-level cancel stops a second synthetic source before publication.
  const otherSource = path.join(srcRoot, 'cancel.bin');
  const otherDest = path.join(dstRoot, 'cancel.bin');
  await fs.writeFile(otherSource, content);
  pauseSourceReads = true;
  const pending = await client.callTool({ name: 'artifact_bridge_transfer_start',
    arguments: { source_device_id: 'source', source_path: otherSource,
      target_device_id: 'destination', target_path: otherDest, project_id: 'Nexowire' } });
  const started = pending.structuredContent as { ok: boolean; data?: { id: string } };
  assert.equal(started.ok, true);
  assert.ok(started.data?.id);
  try {
    await readEntered; // prove source read in-flight, no write dispatched
    const response = await client.callTool({ name: 'artifact_bridge_transfer_cancel',
      arguments: { transfer_id: started.data.id } });
    assert.equal((response.structuredContent as {data?: {state?: string}}).data?.state,
      'CANCEL_REQUESTED');
  } finally {
    releaseSourceRead();
  }
  let cancelled = false;
  for (let i = 0; i < 100; i++) {
    const response = await client.callTool({ name: 'artifact_bridge_transfer_status',
      arguments: { transfer_id: started.data.id } });
    if ((response.structuredContent as { data?: { state: string } }).data?.state === 'CANCELLED') {
      cancelled = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(cancelled, true, 'cancel must prevent any publication');
  // Completion follows the barrier. No wall-clock sleep is evidence of a
  // stopped worker; ensure its persistent journal is side-effect-free.
  const durable = JSON.parse(await fs.readFile(path.join(root, 'hub-state',
    'cross-device-transfer-v1', started.data.id + '.json'), 'utf8')) as {
      state: string; bytesConfirmed: number; pending?: unknown;
    };
  assert.equal(durable.state, 'CANCELLED');
  assert.equal(durable.bytesConfirmed, 0);
  assert.equal(durable.pending, undefined);
  await assert.rejects(fs.stat(otherDest), (e: unknown) =>
    e instanceof Error && 'code' in e && e.code === 'ENOENT');
});
