import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { executeWindowsPrivateViewerCapability } from '../src/agent/windows-private-viewer.js';

test('viewer start reattaches to an existing live WPF process after Agent restart',
  { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-viewer-reattach-'));
    const previous = process.env.NEXOWIRE_PRIVATE_VIEWER_DIR;
    process.env.NEXOWIRE_PRIVATE_VIEWER_DIR = root;
    // Represents a surviving viewer PID without launching a real WPF window.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true, stdio: 'ignore',
    });
    let stopped = false;
    try {
      assert.ok(child.pid, 'surviving viewer fixture must have a PID');
      await delay(100);
      await fs.writeFile(path.join(root, 'state.json'), JSON.stringify({
        version: 1,
        pid: child.pid,
        startedAt: new Date().toISOString(),
        refreshMs: 250,
        maxWidth: 640,
        maxHeight: 360,
        maxBytes: 4194304,
        topmost: false,
        lastFrameAt: new Date().toISOString(),
        frameBytes: 1024,
        frameWidth: 640,
        frameHeight: 360,
        lastError: null,
      }), 'utf8');
      const heartbeat = path.join(root, 'heartbeat.txt');
      await fs.writeFile(heartbeat, new Date().toISOString(), 'utf8');
      const first = (await fs.stat(heartbeat)).mtimeMs;

      const reused = await executeWindowsPrivateViewerCapability(
        'windows.private_viewer.start', {},
      ) as { data: { running: boolean; reused: boolean; pid: number } };
      assert.equal(reused.data.running, true);
      assert.equal(reused.data.reused, true);
      assert.equal(reused.data.pid, child.pid);

      // After reattachment the refresh interval must write a new heartbeat.
      // Frame capture itself may fail without an active private-desktop fixture.
      let refreshed = false;
      for (let i = 0; i < 25; i++) {
        await delay(100);
        if ((await fs.stat(heartbeat)).mtimeMs > first) {
          refreshed = true;
          break;
        }
      }
      assert.equal(refreshed, true, 'reused viewer heartbeat was not resumed');
      await executeWindowsPrivateViewerCapability('windows.private_viewer.stop', {});
      stopped = true;
    } finally {
      if (!stopped) {
        // Only the isolated fixture PID may be signaled; never the Agent.
        child.kill();
      }
      if (previous === undefined) delete process.env.NEXOWIRE_PRIVATE_VIEWER_DIR;
      else process.env.NEXOWIRE_PRIVATE_VIEWER_DIR = previous;
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
