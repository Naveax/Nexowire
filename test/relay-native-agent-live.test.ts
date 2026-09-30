import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AgentBroker } from '../src/core/agent-broker.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { startRelayServer } from '../src/relay/server.js';

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for relayed native agent.');
}

test(
  'real native agent falls back from direct endpoint to first-party relay and executes capabilities',
  {
    skip:
      process.platform !== 'linux' ||
      process.env.NEXOWIRE_LIVE_RELAY_AGENT_TEST !== '1',
  },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-relay-live-'),
    );
    const home = path.join(root, 'home');
    const allowed = path.join(root, 'allowed');
    await Promise.all([
      fs.mkdir(home, { recursive: true }),
      fs.mkdir(allowed, { recursive: true }),
    ]);

    const broker = new AgentBroker();
    const upstreamHttp = createServer();
    const upstreamWss = attachAgentWebSocketServer(
      upstreamHttp,
      broker,
      ['hub-agent-token'],
      { heartbeatMs: 1_000, helloTimeoutMs: 2_000 },
    );
    await new Promise<void>((resolve) =>
      upstreamHttp.listen(0, '127.0.0.1', resolve),
    );
    const upstreamAddress = upstreamHttp.address();
    assert.ok(upstreamAddress && typeof upstreamAddress === 'object');

    const relay = await startRelayServer({
      host: '127.0.0.1',
      port: 0,
      upstreamWsUrl:
        'ws://127.0.0.1:' + upstreamAddress.port + '/agent',
      inboundAgentTokens: ['relay-agent-token'],
      upstreamAgentToken: 'hub-agent-token',
      heartbeatMs: 1_000,
      maxPayloadBytes: 2 * 1024 * 1024,
    });

    let agent: ChildProcess | undefined;
    const stderr: string[] = [];

    t.after(async () => {
      if (agent && agent.exitCode === null) {
        agent.kill('SIGTERM');
        await Promise.race([
          new Promise<void>((resolve) =>
            agent!.once('exit', () => resolve()),
          ),
          new Promise<void>((resolve) =>
            setTimeout(resolve, 5_000),
          ),
        ]);
        if (agent.exitCode === null) agent.kill('SIGKILL');
      }

      await relay.close();
      for (const client of upstreamWss.clients) {
        client.close();
      }
      upstreamWss.close();
      await new Promise<void>((resolve) =>
        upstreamHttp.close(() => resolve()),
      );
      await fs.rm(root, { recursive: true, force: true });
    });

    agent = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'agent'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          // Deliberately dead primary route proves alternate endpoint fallback.
          NEXOWIRE_HUB_WS_URL:
            'ws://127.0.0.1:1/agent',
          NEXOWIRE_HUB_WS_URLS: relay.url,
          NEXOWIRE_AGENT_TOKEN: 'relay-agent-token',
          NEXOWIRE_DEVICE_NAME: 'Relay Native Live',
          NEXOWIRE_ALLOWED_ROOTS: allowed,
          NEXOWIRE_PROCESS_STATE_FILE:
            path.join(root, 'process-sessions.json'),
          NEXOWIRE_TASK_GRAPH_STATE_FILE:
            path.join(root, 'task-graphs.json'),
          NEXOWIRE_PROCESS_WORKER_ROOT:
            path.join(root, 'process-workers'),
          NEXOWIRE_AGENT_HEARTBEAT_MS: '1000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    agent.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString('utf8'));
    });

    const connected = await waitFor(() => {
      const entry = broker
        .list()
        .find((device) => device.name === 'Relay Native Live');
      if (entry) return entry;
      if (agent?.exitCode !== null) {
        throw new Error(
          'Relayed native agent exited early: ' +
            stderr.join('').slice(-4000),
        );
      }
      return undefined;
    });

    assert.equal(connected.platform, 'linux');
    assert.ok(connected.capabilities.includes('machine.snapshot'));
    assert.ok(connected.capabilities.includes('shell.exec'));
    assert.ok(connected.capabilities.includes('files.write'));

    const snapshot = (await broker.request(
      connected.id,
      'machine.snapshot',
      {},
      10_000,
    )) as {
      data: {
        platform: string;
        allowedRoots: string[];
      };
    };
    assert.equal(snapshot.data.platform, 'linux');
    assert.deepEqual(snapshot.data.allowedRoots, [allowed]);

    const shell = (await broker.request(
      connected.id,
      'shell.exec',
      {
        shell: 'bash',
        command: "printf 'relay-shell-ok'",
        cwd: allowed,
        timeout_ms: 10_000,
      },
      15_000,
    )) as {
      stdout: string;
      stderr: string;
      exitCode: number | null;
    };
    assert.equal(shell.exitCode, 0);
    assert.equal(shell.stdout, 'relay-shell-ok');
    assert.equal(shell.stderr, '');

    const file = path.join(allowed, 'relay.txt');
    const written = (await broker.request(
      connected.id,
      'files.write',
      {
        path: file,
        content: 'through-first-party-relay',
        mode: 'overwrite',
      },
      10_000,
    )) as {
      data: { bytesWritten: number };
    };
    assert.equal(written.data.bytesWritten, 25);

    const read = (await broker.request(
      connected.id,
      'files.read',
      {
        path: file,
        include_sha256: true,
      },
      10_000,
    )) as {
      data: {
        content: string;
        sha256: string;
      };
    };
    assert.equal(read.data.content, 'through-first-party-relay');
    assert.match(read.data.sha256, /^[a-f0-9]{64}$/);
  },
);
