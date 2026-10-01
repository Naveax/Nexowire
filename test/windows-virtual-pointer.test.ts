import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  executeWindowsVirtualPointerCapability,
} from '../src/agent/windows-virtual-pointer.js';
import {
  executeWindowsPointerCapability,
} from '../src/agent/windows-pointer.js';
import {
  executeWindowsWindowCapability,
} from '../src/agent/windows-window-control.js';
import { isReadOnlyCapability } from '../src/protocol/capabilities.js';

test('virtual pointer status is read-only while lifecycle/style/move are mutations', () => {
  assert.equal(
    isReadOnlyCapability('windows.virtual_pointer.status'),
    true,
  );

  for (const capability of [
    'windows.virtual_pointer.start',
    'windows.virtual_pointer.stop',
    'windows.virtual_pointer.move',
    'windows.virtual_pointer.style',
    'windows.virtual_pointer.visibility',
  ]) {
    assert.equal(isReadOnlyCapability(capability), false, capability);
  }
});

test(
  'Nexowire virtual pointer renders independently without moving the Windows cursor',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-virtual-pointer-'),
    );
    const previousRoot = process.env.NEXOWIRE_VIRTUAL_POINTER_DIR;
    process.env.NEXOWIRE_VIRTUAL_POINTER_DIR = root;

    t.after(async () => {
      try {
        await executeWindowsVirtualPointerCapability(
          'windows.virtual_pointer.stop',
          {},
        );
      } catch {
        // Best effort cleanup.
      }
      if (previousRoot === undefined) {
        delete process.env.NEXOWIRE_VIRTUAL_POINTER_DIR;
      } else {
        process.env.NEXOWIRE_VIRTUAL_POINTER_DIR = previousRoot;
      }
      await fs.rm(root, { recursive: true, force: true });
    });

    const before = (await executeWindowsPointerCapability(
      'windows.pointer.position',
      {},
    )) as {
      data: { screenPoint: { x: number; y: number } };
    };

    const start = (await executeWindowsVirtualPointerCapability(
      'windows.virtual_pointer.start',
      {
        x: 320,
        y: 240,
        color: '#FF2BD6',
        size: 48,
        opacity: 0.9,
        label: 'NX',
        visible: true,
      },
    )) as {
      data: {
        running: boolean;
        pid: number;
        touchesSystemCursor: boolean;
        clickThrough: boolean;
      };
    };

    assert.equal(start.data.running, true);
    assert.ok(start.data.pid > 0);
    assert.equal(start.data.touchesSystemCursor, false);
    assert.equal(start.data.clickThrough, true);

    const overlay = (await executeWindowsWindowCapability(
      'windows.window.list',
      {
        include_hidden: true,
        title_contains: 'Nexowire Virtual Pointer Overlay',
        limit: 10,
      },
    )) as {
      data: {
        windows: Array<{
          hwnd: string;
          visible: boolean;
          foreground: boolean;
        }>;
      };
    };
    assert.equal(overlay.data.windows.length, 1);
    assert.equal(overlay.data.windows[0]?.visible, true);
    assert.equal(overlay.data.windows[0]?.foreground, false);

    const move = (await executeWindowsVirtualPointerCapability(
      'windows.virtual_pointer.move',
      {
        x: 900,
        y: 520,
      },
    )) as {
      data: {
        running: boolean;
        state: { x: number; y: number };
        touchesSystemCursor: boolean;
      };
    };
    assert.equal(move.data.running, true);
    assert.equal(move.data.state.x, 900);
    assert.equal(move.data.state.y, 520);
    assert.equal(move.data.touchesSystemCursor, false);

    const styled = (await executeWindowsVirtualPointerCapability(
      'windows.virtual_pointer.style',
      {
        color: '#00E5FF',
        size: 42,
        label: 'AI',
      },
    )) as {
      data: {
        state: { color: string; size: number; label: string };
      };
    };
    assert.equal(styled.data.state.color, '#00E5FF');
    assert.equal(styled.data.state.size, 42);
    assert.equal(styled.data.state.label, 'AI');

    const after = (await executeWindowsPointerCapability(
      'windows.pointer.position',
      {},
    )) as {
      data: { screenPoint: { x: number; y: number } };
    };

    assert.deepEqual(
      after.data.screenPoint,
      before.data.screenPoint,
      'moving the Nexowire virtual pointer must not move the Windows system cursor',
    );

    const hidden = (await executeWindowsVirtualPointerCapability(
      'windows.virtual_pointer.visibility',
      { visible: false },
    )) as {
      data: { state: { visible: boolean } };
    };
    assert.equal(hidden.data.state.visible, false);

    const status = (await executeWindowsVirtualPointerCapability(
      'windows.virtual_pointer.status',
      {},
    )) as {
      data: {
        running: boolean;
        state: { x: number; y: number; visible: boolean };
        isolation: string;
      };
    };
    assert.equal(status.data.running, true);
    assert.equal(status.data.state.x, 900);
    assert.equal(status.data.state.y, 520);
    assert.equal(status.data.state.visible, false);
    assert.equal(status.data.isolation, 'visual-pointer-only');

    const stopped = (await executeWindowsVirtualPointerCapability(
      'windows.virtual_pointer.stop',
      {},
    )) as {
      data: { running: boolean; stopped: boolean };
    };
    assert.equal(stopped.data.running, false);
    assert.equal(stopped.data.stopped, true);
  },
);
