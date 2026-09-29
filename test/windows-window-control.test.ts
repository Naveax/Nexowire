import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWindowsWindowCapability } from '../src/agent/windows-window-control.js';

test(
  'Windows window enumeration returns structured HWND metadata',
  { skip: process.platform !== 'win32' },
  async () => {
    const result = (await executeWindowsWindowCapability(
      'windows.window.list',
      {
        include_hidden: false,
        limit: 200,
      },
    )) as {
      data: {
        windows: Array<{
          hwnd: string;
          title: string;
          processId: number;
          visible: boolean;
          minimized: boolean;
          foreground: boolean;
          rect:
            | {
                left: number;
                top: number;
                right: number;
                bottom: number;
                width: number;
                height: number;
              }
            | null;
        }>;
        truncated: boolean;
        foregroundHwnd: string | null;
      };
    };

    assert.ok(Array.isArray(result.data.windows));
    assert.equal(typeof result.data.truncated, 'boolean');
    for (const item of result.data.windows) {
      assert.match(item.hwnd, /^0x[0-9A-F]+$/);
      assert.equal(typeof item.title, 'string');
      assert.ok(Number.isInteger(item.processId));
      assert.equal(typeof item.visible, 'boolean');
      assert.equal(typeof item.minimized, 'boolean');
      assert.equal(typeof item.foreground, 'boolean');
      if (item.rect) {
        assert.equal(item.rect.width, item.rect.right - item.rect.left);
        assert.equal(item.rect.height, item.rect.bottom - item.rect.top);
      }
    }

    if (result.data.foregroundHwnd) {
      assert.match(result.data.foregroundHwnd, /^0x[0-9A-F]+$/);
      assert.ok(
        result.data.windows.some(
          (item) =>
            item.hwnd === result.data.foregroundHwnd ||
            item.foreground === true,
        ) ||
          result.data.windows.length === 200,
      );
    }
  },
);

test(
  'Windows window list supports title and process filters',
  { skip: process.platform !== 'win32' },
  async () => {
    const baseline = (await executeWindowsWindowCapability(
      'windows.window.list',
      { include_hidden: false, limit: 200 },
    )) as {
      data: {
        windows: Array<{
          title: string;
          processId: number;
        }>;
      };
    };

    const titled = baseline.data.windows.find(
      (item) => item.title.trim().length >= 3,
    );
    if (!titled) return;

    const fragment = titled.title.slice(0, 3);
    const filtered = (await executeWindowsWindowCapability(
      'windows.window.list',
      {
        include_hidden: false,
        title_contains: fragment,
        process_id: titled.processId,
        limit: 200,
      },
    )) as {
      data: {
        windows: Array<{ title: string; processId: number }>;
      };
    };

    assert.ok(filtered.data.windows.length >= 1);
    assert.ok(
      filtered.data.windows.every(
        (item) =>
          item.processId === titled.processId &&
          item.title.toLowerCase().includes(fragment.toLowerCase()),
      ),
    );
  },
);

test(
  'Windows focus rejects an invalid HWND without mutating anything',
  { skip: process.platform !== 'win32' },
  async () => {
    await assert.rejects(
      () =>
        executeWindowsWindowCapability('windows.window.focus', {
          hwnd: '0x0',
        }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WINDOW_NOT_FOUND',
    );
  },
);

test(
  'Windows can verify focus when targeting the current foreground HWND',
  { skip: process.platform !== 'win32' },
  async () => {
    const listed = (await executeWindowsWindowCapability(
      'windows.window.list',
      {
        include_hidden: true,
        limit: 500,
      },
    )) as {
      data: {
        foregroundHwnd: string | null;
        windows: Array<{ hwnd: string }>;
      };
    };

    const hwnd = listed.data.foregroundHwnd;
    if (!hwnd) return;

    const focused = (await executeWindowsWindowCapability(
      'windows.window.focus',
      {
        hwnd,
        restore_if_minimized: true,
      },
    )) as {
      data: {
        hwnd: string;
        verified: boolean;
        foregroundHwnd: string | null;
      };
    };

    assert.equal(focused.data.hwnd, hwnd);
    assert.equal(focused.data.verified, true);
    assert.equal(focused.data.foregroundHwnd, hwnd);
  },
);
