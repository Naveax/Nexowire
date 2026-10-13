import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeWindowsPrivateViewerCapability } from '../src/agent/windows-private-viewer.js';

test('private viewer reports live/stale/error/unavailable capture health without launching UI',
  { skip: process.platform !== 'win32' }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-private-health-'));
    const previous = process.env.NEXOWIRE_PRIVATE_VIEWER_DIR;
    process.env.NEXOWIRE_PRIVATE_VIEWER_DIR = root;
    const state = {
      version: 1,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      refreshMs: 750,
      maxWidth: 1280,
      maxHeight: 720,
      maxBytes: 4194304,
      topmost: false,
      lastFrameAt: new Date().toISOString() as string | null,
      frameBytes: 1024,
      frameWidth: 800,
      frameHeight: 450,
      lastError: null as string | null,
    };
    const status = async () => {
      await fs.writeFile(path.join(root, 'state.json'), JSON.stringify(state), 'utf8');
      const result = await executeWindowsPrivateViewerCapability(
        'windows.private_viewer.status', {},
      ) as { data: { running: boolean; frameHealth: string;
        frameAgeMs: number | null; maxLiveFrameAgeMs: number;
        lastError: string | null } };
      assert.equal(result.data.running, true);
      return result.data;
    };
    try {
      await fs.writeFile(path.join(root, 'heartbeat.txt'), new Date().toISOString(), 'utf8');
      assert.equal((await status()).frameHealth, 'live');
      state.lastFrameAt = new Date(Date.now() - 9_000).toISOString();
      const stale = await status();
      assert.equal(stale.frameHealth, 'stale');
      assert.ok((stale.frameAgeMs ?? 0) > stale.maxLiveFrameAgeMs);
      state.lastError = 'Desktop capture failed';
      const failed = await status();
      assert.equal(failed.frameHealth, 'error');
      assert.equal(failed.lastError, 'Desktop capture failed');
      state.lastError = null;
      state.lastFrameAt = null;
      const empty = await status();
      assert.equal(empty.frameHealth, 'unavailable');
      assert.equal(empty.frameAgeMs, null);
      state.lastFrameAt = 'not-a-date';
      assert.equal((await status()).frameHealth, 'unavailable');
    } finally {
      if (previous === undefined) delete process.env.NEXOWIRE_PRIVATE_VIEWER_DIR;
      else process.env.NEXOWIRE_PRIVATE_VIEWER_DIR = previous;
      // Do not call viewerStop(): fake state deliberately uses this test process's PID.
      await fs.rm(root, { force: true, recursive: true });
    }
  },
);

test('WPF viewer distinguishes stale capture and stale private-window inventory from live data', async () => {
  const source = await fs.readFile(
    path.resolve('src/agent/windows-private-viewer.ts'), 'utf8',
  );
  assert.match(source, /\[string\]\$StatePath/);
  assert.match(source, /'-StatePath',\s*p\.state/);
  assert.match(source, /function Update-CaptureHealth \{/);
  assert.match(source, /Update-CaptureHealth\s+if\(Test-Path -LiteralPath \$EmergencyResultPath\)/);
  assert.match(source, /STALE FRAME:/);
  assert.match(source, /CAPTURE ERROR:/);
  assert.match(source, /CAPTURE STATUS UNAVAILABLE:/);
  assert.match(source, /Window inventory stale/);
  assert.match(source, /Window inventory unreadable/);
});
