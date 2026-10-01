import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AgentBroker } from '../src/core/agent-broker.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for live macOS native agent.');
}

test(
  'real macOS native agent connects outbound and executes core capabilities',
  {
    skip:
      process.platform !== 'darwin' ||
      process.env.NEXOWIRE_LIVE_MACOS_AGENT_TEST !== '1',
  },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-macos-live-'),
    );
    const home = path.join(root, 'home');
    const allowed = path.join(root, 'allowed');
    await Promise.all([
      fs.mkdir(home, { recursive: true }),
      fs.mkdir(allowed, { recursive: true }),
    ]);

    const broker = new AgentBroker();
    const http = createServer();
    const wss = attachAgentWebSocketServer(http, broker);

    await new Promise<void>((resolve) =>
      http.listen(0, '127.0.0.1', resolve),
    );
    const address = http.address();
    assert.ok(address && typeof address === 'object');

    let agent: ChildProcess | undefined;
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
      for (const client of wss.clients) client.close();
      wss.close();
      await new Promise<void>((resolve) =>
        http.close(() => resolve()),
      );
      await fs.rm(root, { recursive: true, force: true });
    });

    const stderr: string[] = [];
    agent = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'agent'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          NEXOWIRE_HUB_WS_URL:
            'ws://127.0.0.1:' + address.port + '/agent',
          NEXOWIRE_DEVICE_NAME: 'macOS Native Live',
          NEXOWIRE_ALLOWED_ROOTS: allowed,
          NEXOWIRE_PROCESS_STATE_FILE:
            path.join(root, 'process-sessions.json'),
          NEXOWIRE_TASK_GRAPH_STATE_FILE:
            path.join(root, 'task-graphs.json'),
          NEXOWIRE_PROCESS_WORKER_ROOT:
            path.join(root, 'process-workers'),
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
        .find((device) => device.name === 'macOS Native Live');
      if (entry) return entry;
      if (agent?.exitCode !== null) {
        throw new Error(
          'macOS native agent exited early: ' +
            stderr.join('').slice(-4000),
        );
      }
      return undefined;
    });

    assert.equal(connected.platform, 'darwin');
    assert.ok(connected.capabilities.includes('shell.exec'));
    assert.ok(connected.capabilities.includes('files.read'));
    assert.ok(connected.capabilities.includes('process.start'));
    assert.equal(
      connected.capabilities.some(
        (capability) => capability.startsWith('windows.'),
      ),
      false,
    );
    assert.equal(connected.capabilities.includes('wsl.exec'), false);

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
    assert.equal(snapshot.data.platform, 'darwin');
    assert.deepEqual(snapshot.data.allowedRoots, [allowed]);

    const shell = (await broker.request(
      connected.id,
      'shell.exec',
      {
        shell: 'bash',
        command: "printf 'nexowire-macos'",
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
    assert.equal(shell.stdout, 'nexowire-macos');
    assert.equal(shell.stderr, '');

    const file = path.join(allowed, 'live.txt');
    const written = (await broker.request(
      connected.id,
      'files.write',
      {
        path: file,
        content: 'native-macos-file',
        mode: 'overwrite',
      },
      10_000,
    )) as {
      data: { bytesWritten: number };
    };
    assert.equal(written.data.bytesWritten, 17);

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
    assert.equal(read.data.content, 'native-macos-file');
    assert.match(read.data.sha256, /^[a-f0-9]{64}$/);

    const started = (await broker.request(
      connected.id,
      'process.start',
      {
        shell: 'bash',
        cwd: allowed,
        command: "printf 'process-ok'; sleep 0.05",
      },
      10_000,
    )) as {
      data: {
        sessionId: string;
      };
    };
    assert.match(
      started.data.sessionId,
      /^[0-9a-f-]{36}$/i,
    );

    let afterSeq = 0;
    let processStatus = 'running';
    let output = '';
    for (let attempt = 0; attempt < 60; attempt++) {
      const current = (await broker.request(
        connected.id,
        'process.read',
        {
          session_id: started.data.sessionId,
          after_seq: afterSeq,
          wait_ms: 100,
        },
        10_000,
      )) as {
        data: {
          session: { status: string };
          events: Array<{
            seq: number;
            stream: string;
            text: string;
          }>;
          nextSeq: number;
        };
      };
      afterSeq = current.data.nextSeq;
      processStatus = current.data.session.status;
      output += current.data.events
        .filter((event) => event.stream === 'stdout')
        .map((event) => event.text)
        .join('');
      if (processStatus !== 'running') break;
    }

    assert.equal(processStatus, 'exited');
    assert.equal(output, 'process-ok');
  },
);
