import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { ProcessManager } from '../src/agent/process-manager.js';
import { PathPolicy } from '../src/agent/path-policy.js';

/**
 * Independent QA19 for the *durable sidecar* path through process-worker.ts.
 * This is NOT the existing 100-cycle volatile ProcessManager test. A durable
 * worker must persist BOTH streams before it publishes terminal status, even
 * when the root exits while launchWindowsJob and status.json are awaited.
 *
 * Exclusively creates its own temporary worker directory and disposable
 * cmd.exe children. No installed Agent, Broker, ACL, VM or arbitrary PID.
 */
test('QA19 Windows durable Job rapid exit persists stdout and stderr before exited', {
  skip: process.platform !== 'win32',
  timeout: 240_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nw-qa19-durable-'));
  const workerRoot = path.join(root, 'workers');
  const manager = new ProcessManager({
    stateFile: path.join(root, 'sessions.json'),
    workerRoot,
    workerEntrypoint: path.resolve('src/cli.ts'),
    workerExecArgv: process.execArgv,
    exitedRetentionMs: 60_000,
  });
  const policy = new PathPolicy(['*']);

  try {
    await manager.initialize();

    // Just one distinct durable regression, with a bounded series to expose
    // scheduler-dependent early-output/early-close ordering on hosted Windows.
    for (let cycle = 0; cycle < 12; cycle++) {
      const token = 'NW19_DURABLE_' + String(cycle).padStart(2, '0');
      const stdoutMarker = token + '_OUT';
      const stderrMarker = token + '_ERR';
      const command = cycle % 2 === 0
        ? 'echo ' + stdoutMarker + ' & echo ' + stderrMarker + ' 1>&2'
        : 'echo ' + stderrMarker + ' 1>&2 & echo ' + stdoutMarker;

      const started = await manager.start({
        shell: 'cmd',
        command,
        durable: true,
      }, policy);
      assert.equal(started.durable, true, 'must use durable sidecar cycle ' + cycle);
      assert.ok(started.pid, 'durable root PID missing cycle ' + cycle);

      let cursor = 0;
      let stdout = '';
      let stderr = '';
      let terminal = false;

      // Inspect the public durable API, not the native guardian's stdout.
      for (let poll = 0; poll < 120; poll++) {
        const read = await manager.read({
          session_id: started.sessionId,
          after_seq: cursor,
          max_events: 100,
          wait_ms: 100,
        });
        for (const event of read.events) {
          assert.ok(event.seq > cursor,
            'nonmonotonic durable event cycle ' + cycle);
          cursor = event.seq;
          if (event.stream === 'stdout') stdout += event.text;
          else if (event.stream === 'stderr') stderr += event.text;
          else assert.fail('unexpected durable event stream cycle ' + cycle);
        }
        assert.equal(read.nextSeq, cursor, 'durable cursor mismatch cycle ' + cycle);

        if (read.session.status !== 'running') {
          assert.equal(read.session.status, 'exited',
            'durable terminal must not be lost/orphaned cycle ' + cycle);
          assert.equal(read.session.exitCode, 0,
            'rapid fixture must exit successfully cycle ' + cycle);
          assert.equal(stdout.split(stdoutMarker).length - 1, 1,
            'stdout missing/duplicated BEFORE durable exited cycle ' + cycle);
          assert.equal(stderr.split(stderrMarker).length - 1, 1,
            'stderr missing/duplicated BEFORE durable exited cycle ' + cycle);
          terminal = true;
          break;
        }
      }
      assert.ok(terminal,
        'durable worker never persisted verified exited with both streams cycle ' + cycle);

      // Distinct from the volatile test: verify the worker's disk-backed
      // journal and atomic terminal status, not just ProcessManager memory.
      const dir = path.join(workerRoot, started.sessionId);
      const status = JSON.parse(await fs.readFile(path.join(dir, 'status.json'), 'utf8')) as {
        version: number;
        sessionId: string;
        status: string;
        exitCode: number | null;
        nextSeq: number;
      };
      assert.equal(status.version, 1);
      assert.equal(status.sessionId, started.sessionId);
      assert.equal(status.status, 'exited',
        'disk-backed durable terminal missing cycle ' + cycle);
      assert.equal(status.exitCode, 0);

      const lines = (await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8'))
        .split(/\r?\n/).filter(Boolean);
      const persisted = lines.map(line => JSON.parse(line) as {
        seq: number;
        stream: string;
        text: string;
      });
      for (let i = 0; i < persisted.length; i++) {
        assert.equal(persisted[i]!.seq, i + 1,
          'durable journal sequence hole/replay cycle ' + cycle);
      }
      assert.equal(status.nextSeq, persisted.length + 1,
        'terminal status published before durable output journal cycle ' + cycle);
      assert.equal(
        persisted.filter(event => event.stream === 'stdout')
          .map(event => event.text).join('').split(stdoutMarker).length - 1,
        1, 'disk-backed stdout lost/duplicated cycle ' + cycle,
      );
      assert.equal(
        persisted.filter(event => event.stream === 'stderr')
          .map(event => event.text).join('').split(stderrMarker).length - 1,
        1, 'disk-backed stderr lost/duplicated cycle ' + cycle,
      );

      await new Promise(resolve => setTimeout(resolve, 25));
      const later = await manager.read({
        session_id: started.sessionId,
        after_seq: cursor,
        wait_ms: 0,
      });
      assert.equal(later.session.status, 'exited',
        'durable terminal state regressed cycle ' + cycle);
      assert.equal(later.events.length, 0,
        'late stdout/stderr appeared AFTER durable exited cycle ' + cycle);
    }
  } finally {
    // Stop only sessions created by this test-owned ProcessManager.
    await manager.stopAll().catch(() => undefined);
    await manager.shutdown().catch(() => undefined);
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 12,
      retryDelay: 100,
    });
  }
});
