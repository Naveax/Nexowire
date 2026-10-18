import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';
import { ProcessManager } from '../src/agent/process-manager.js';
import { ProgressSupervisor } from '../src/agent/progress-supervisor.js';

test('real managed synthetic process: process.start/read progress separated from PID and proof', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-progress-integ-'));
  const progressSupervisor = new ProgressSupervisor({ stallAfterMs: 1000 });
  const manager = new ProcessManager({
    stateFile: path.join(dir, 'sessions.json'),
    onEvent: event => progressSupervisor.observeProcessEvent(event),
  });
  try {
    await manager.initialize();
    const fixture = path.resolve('test/fixtures/progress-proof-fixture.cjs');
    const started = (await executeCapability('process.start', {
      command: 'node "' + fixture + '"',
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      cwd: dir,
    }, new PathPolicy(['*']), { processes: manager, progressSupervisor })) as {
      data: { sessionId: string; progress: Record<string, unknown> };
    };
    assert.ok(started.data.sessionId);
    const initial = started.data.progress;
    assert.equal(initial.state, 'progress_unknown');
    let latest: { data: {
      session: { status: string; exitCode: number | null };
      progress: Record<string, unknown>;
    } } | undefined;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      latest = (await executeCapability('process.read', {
        session_id: started.data.sessionId, wait_ms: 100, max_events: 30,
      }, new PathPolicy(['*']), { processes: manager, progressSupervisor })) as typeof latest;
      if (latest?.data.progress.completedCount === 2) break;
    }
    assert.ok(latest, 'process.read must return session');
    assert.ok(['running', 'exited'].includes(latest.data.session.status));
    assert.equal(latest.data.progress.completedCount, 2);
    assert.equal(latest.data.progress.pendingCount, 0);
    assert.ok(['active', 'reported_complete'].includes(String(latest.data.progress.state)));
    assert.equal(latest.data.progress.completionEvidence, 'self_reported_unverified');
    assert.equal(latest.data.progress.progressVerified, false);
    assert.equal(latest.data.progress.lastVerifiedProgressAt, null);
  } finally {
    await manager.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
