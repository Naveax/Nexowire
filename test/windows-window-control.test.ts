import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
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
  async (t) => {
    const title =
      'Nexowire Window Filter Fixture ' +
      process.pid +
      '-' +
      Date.now();

    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName PresentationFramework',
      '$window = New-Object System.Windows.Window',
      '$window.Title = $env:NEXOWIRE_WINDOW_FILTER_TITLE',
      '$window.Width = 420',
      '$window.Height = 180',
      "$window.WindowStartupLocation = 'Manual'",
      '$window.Left = 70',
      '$window.Top = 70',
      '[void]$window.Show()',
      "[Console]::Out.WriteLine('READY')",
      '[Console]::Out.Flush()',
      '[System.Windows.Threading.Dispatcher]::Run()',
    ].join('; ');

    let child: ChildProcess | undefined;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-STA',
          '-Command',
          script,
        ],
        {
          windowsHide: false,
          env: {
            ...process.env,
            NEXOWIRE_WINDOW_FILTER_TITLE: title,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      const ready = await new Promise<boolean>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => resolve(false), 8_000);
        child!.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (!stdout.includes('READY')) return;
          clearTimeout(timer);
          resolve(true);
        });
        child!.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child!.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child!.once('exit', (code) => {
          if (stdout.includes('READY')) return;
          clearTimeout(timer);
          reject(
            new Error(
              'Window filter fixture exited before readiness: ' +
                String(code) +
                ' stderr=' +
                stderr,
            ),
          );
        });
      });

      if (!ready || !child.pid) {
        t.skip(
          'Runner session could not expose a deterministic WPF window fixture.',
        );
        return;
      }

      let filtered:
        | {
            data: {
              windows: Array<{
                title: string;
                processId: number;
              }>;
            };
          }
        | undefined;

      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        filtered = (await executeWindowsWindowCapability(
          'windows.window.list',
          {
            include_hidden: false,
            title_contains: title,
            process_id: child.pid,
            limit: 20,
          },
        )) as typeof filtered;

        if ((filtered?.data.windows.length ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok(filtered);
      assert.ok(filtered.data.windows.length >= 1);
      assert.ok(
        filtered.data.windows.every(
          (item) =>
            item.processId === child!.pid &&
            item.title.toLowerCase().includes(title.toLowerCase()),
        ),
      );
    } finally {
      if (child && child.exitCode === null) child.kill();
    }
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
