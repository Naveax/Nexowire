import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { executeWindowsInputCapability } from '../src/agent/windows-input.js';
import { executeWindowsWindowCapability } from '../src/agent/windows-window-control.js';
import { isReadOnlyCapability } from '../src/protocol/capabilities.js';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 6_000,
  intervalMs = 100,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

test(
  'Windows clipboard read is bounded and read-only',
  { skip: process.platform !== 'win32' },
  async (t) => {
    try {
      const result = (await executeWindowsInputCapability(
        'windows.clipboard.read',
        { max_chars: 128 },
      )) as {
        data: {
          textAvailable: boolean;
          chars: number;
          truncated: boolean;
          text: string;
          sha256: string;
          hashScope: string;
        };
      };

      assert.equal(typeof result.data.textAvailable, 'boolean');
      assert.ok(result.data.chars >= 0);
      assert.ok(result.data.text.length <= 128);
      assert.match(result.data.sha256, /^[a-f0-9]{64}$/);
      assert.ok(['full-text', 'returned-prefix'].includes(result.data.hashScope));
      assert.equal(
        isReadOnlyCapability('windows.clipboard.read'),
        true,
      );
    } catch (error) {
      if (errorCode(error) === 'CLIPBOARD_UNAVAILABLE') {
        t.skip('Runner has no interactive Windows clipboard.');
        return;
      }
      throw error;
    }
  },
);

test('Windows input mutation capabilities are not read-only', () => {
  for (const capability of [
    'windows.clipboard.write',
    'windows.clipboard.clear',
    'windows.keyboard.type',
    'windows.keyboard.hotkey',
  ]) {
    assert.equal(isReadOnlyCapability(capability), false, capability);
  }
});

test(
  'keyboard input refuses invalid or non-target windows before injection',
  { skip: process.platform !== 'win32' },
  async () => {
    await assert.rejects(
      () =>
        executeWindowsInputCapability('windows.keyboard.type', {
          hwnd: '0x0',
          text: 'must-not-type',
        }),
      (error: unknown) => errorCode(error) === 'WINDOW_NOT_FOUND',
    );

    await assert.rejects(
      () =>
        executeWindowsInputCapability('windows.keyboard.hotkey', {
          hwnd: '0x0',
          keys: ['CTRL', 'S'],
        }),
      (error: unknown) => errorCode(error) === 'WINDOW_NOT_FOUND',
    );
  },
);

test(
  'hotkey validation rejects unsupported and duplicate keys before input',
  { skip: process.platform !== 'win32' },
  async () => {
    await assert.rejects(
      () =>
        executeWindowsInputCapability('windows.keyboard.hotkey', {
          hwnd: '0x1234',
          keys: ['CTRL', 'CTRL'],
        }),
      (error: unknown) => errorCode(error) === 'DUPLICATE_HOTKEY_KEY',
    );

    await assert.rejects(
      () =>
        executeWindowsInputCapability('windows.keyboard.hotkey', {
          hwnd: '0x1234',
          keys: ['CTRL', 'NOT_A_KEY'],
        }),
      (error: unknown) => errorCode(error) === 'UNSUPPORTED_HOTKEY',
    );
  },
);

test(
  'interactive keyboard typing targets one exact Notepad HWND and saves text',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-input-'));
    const file = path.join(root, 'input-test.txt');
    await fs.writeFile(file, '', 'utf8');

    const child = spawn('notepad.exe', [file], {
      detached: false,
      windowsHide: false,
      stdio: 'ignore',
    });

    const cleanup = async () => {
      try {
        child.kill();
      } catch {
        // Best effort test cleanup.
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      await fs.rm(root, { recursive: true, force: true });
    };
    t.after(cleanup);

    const window = await waitFor(async () => {
      const listed = (await executeWindowsWindowCapability(
        'windows.window.list',
        {
          include_hidden: false,
          process_id: child.pid,
          limit: 20,
        },
      )) as {
        data: {
          windows: Array<{
            hwnd: string;
            title: string;
            visible: boolean;
          }>;
        };
      };
      return listed.data.windows.find(
        (entry) => entry.visible && entry.title.trim().length > 0,
      );
    });

    if (!window) {
      t.skip('Notepad window is unavailable in this Windows session.');
      return;
    }

    try {
      await executeWindowsWindowCapability('windows.window.focus', {
        hwnd: window.hwnd,
        restore_if_minimized: true,
      });
    } catch (error) {
      if (errorCode(error) === 'WINDOW_FOCUS_NOT_VERIFIED') {
        t.skip('Runner cannot foreground the isolated Notepad window.');
        return;
      }
      throw error;
    }

    const marker = 'nexowire-keyboard-' + Date.now();
    await executeWindowsInputCapability('windows.keyboard.type', {
      hwnd: window.hwnd,
      text: marker,
      interval_ms: 1,
    });
    await executeWindowsInputCapability('windows.keyboard.hotkey', {
      hwnd: window.hwnd,
      keys: ['CTRL', 'S'],
    });

    const saved = await waitFor(async () => {
      const value = await fs.readFile(file, 'utf8');
      return value.includes(marker) ? value : undefined;
    }, 8_000, 100);

    assert.ok(saved?.includes(marker));
  },
);
