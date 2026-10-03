import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  executeWindowsPrivateViewerCapability,
} from '../src/agent/windows-private-viewer.js';

test(
  'private viewer status/stop are safe with no running viewer',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        'nexowire-private-viewer-test-',
      ),
    );
    const previous =
      process.env.NEXOWIRE_PRIVATE_VIEWER_DIR;
    process.env.NEXOWIRE_PRIVATE_VIEWER_DIR =
      root;

    try {
      assert.deepEqual(
        await executeWindowsPrivateViewerCapability(
          'windows.private_viewer.status',
          {},
        ),
        {
          data: {
            running: false,
            localViewer: true,
          },
        },
      );

      assert.deepEqual(
        await executeWindowsPrivateViewerCapability(
          'windows.private_viewer.stop',
          {},
        ),
        {
          data: {
            running: false,
            stopped: false,
            localViewer: true,
          },
        },
      );

      const entries = await fs.readdir(root);
      assert.deepEqual(entries, []);
    } finally {
      if (previous === undefined) {
        delete process.env
          .NEXOWIRE_PRIVATE_VIEWER_DIR;
      } else {
        process.env.NEXOWIRE_PRIVATE_VIEWER_DIR =
          previous;
      }
      await fs.rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

test(
  'private viewer rejects unsupported operations without opening UI',
  { skip: process.platform !== 'win32' },
  async () => {
    await assert.rejects(
      executeWindowsPrivateViewerCapability(
        'windows.private_viewer.unknown',
        {},
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'UNSUPPORTED',
    );
  },
);
