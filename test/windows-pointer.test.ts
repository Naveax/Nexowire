import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { executeWindowsPointerCapability } from '../src/agent/windows-pointer.js';
import { executeWindowsWindowCapability } from '../src/agent/windows-window-control.js';
import { executeWindowsAccessibilityCapability } from '../src/agent/windows-accessibility.js';
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
  timeoutMs = 8_000,
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

async function startPointerFixture(): Promise<{
  root: string;
  marker: string;
  hwnd: string;
  child: ChildProcess;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-pointer-'),
  );
  const marker = path.join(root, 'clicked.txt');
  const scriptPath = path.join(root, 'fixture.ps1');

  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$window = New-Object System.Windows.Window
$window.Title = 'Nexowire Pointer Fixture'
$window.Width = 460
$window.Height = 260
$window.WindowStartupLocation = 'Manual'
$window.Left = 80
$window.Top = 80

$canvas = New-Object System.Windows.Controls.Canvas

$button = New-Object System.Windows.Controls.Button
$button.Content = 'Nexowire Pointer Button'
$button.Width = 180
$button.Height = 60
[System.Windows.Automation.AutomationProperties]::SetName(
  $button,
  'Nexowire Pointer Button'
)
[System.Windows.Automation.AutomationProperties]::SetAutomationId(
  $button,
  'NexowirePointerButton'
)
[System.Windows.Controls.Canvas]::SetLeft($button, 100)
[System.Windows.Controls.Canvas]::SetTop($button, 70)

$button.Add_Click({
  [System.IO.File]::WriteAllText(
    $env:NEXOWIRE_POINTER_MARKER,
    'clicked'
  )
})

[void]$canvas.Children.Add($button)
$window.Content = $canvas

$helper = New-Object System.Windows.Interop.WindowInteropHelper($window)
[void]$helper.EnsureHandle()
$window.Show()
[Console]::Out.WriteLine(
  ('HWND=0x{0:X}' -f $helper.Handle.ToInt64())
)
[Console]::Out.Flush()
[System.Windows.Threading.Dispatcher]::Run()
`;
  await fs.writeFile(scriptPath, script, 'utf8');

  const child = spawn(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-File',
      scriptPath,
    ],
    {
      windowsHide: false,
      env: {
        ...process.env,
        NEXOWIRE_POINTER_MARKER: marker,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const hwnd = await new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(
        new Error(
          'Timed out waiting for pointer fixture HWND. stderr=' +
            stderr,
        ),
      );
    }, 8_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = /HWND=(0x[0-9A-F]+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]!);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          'Pointer fixture exited before HWND publication: ' +
            String(code) +
            ' stderr=' +
            stderr,
        ),
      );
    });
  });

  return { root, marker, hwnd, child };
}

test('pointer position is read-only while pointer mutations are not', () => {
  assert.equal(
    isReadOnlyCapability('windows.pointer.position'),
    true,
  );
  for (const capability of [
    'windows.pointer.move',
    'windows.pointer.click',
    'windows.pointer.scroll',
  ]) {
    assert.equal(
      isReadOnlyCapability(capability),
      false,
      capability,
    );
  }
});

test(
  'pointer validation fails closed before sending input',
  { skip: process.platform !== 'win32' },
  async () => {
    await assert.rejects(
      () =>
        executeWindowsPointerCapability('windows.pointer.move', {
          hwnd: '0x1234',
          coordinate_mode: 'normalized',
          x: 1.2,
          y: 0.5,
        }),
      /normalized coordinates must both be between 0 and 1/,
    );

    await assert.rejects(
      () =>
        executeWindowsPointerCapability('windows.pointer.move', {
          hwnd: '0x1234',
          coordinate_mode: 'client_pixels',
          x: 1.5,
          y: 4,
        }),
      /client_pixels coordinates must be integer pixel positions/,
    );

    await assert.rejects(
      () =>
        executeWindowsPointerCapability('windows.pointer.click', {
          hwnd: '0x0',
          x: 0,
          y: 0,
        }),
      (error: unknown) => errorCode(error) === 'WINDOW_NOT_FOUND',
    );
  },
);

test(
  'Windows pointer can move/click/scroll inside one exact foreground HWND',
  { skip: process.platform !== 'win32' },
  async (t) => {
    let fixture:
      | {
          root: string;
          marker: string;
          hwnd: string;
          child: ChildProcess;
        }
      | undefined;

    try {
      fixture = await startPointerFixture();
    } catch (error) {
      t.skip(
        'Could not create isolated pointer fixture: ' +
          (error instanceof Error ? error.message : String(error)),
      );
      return;
    }

    t.after(async () => {
      try {
        fixture?.child.kill();
      } catch {
        // Best effort fixture cleanup.
      }
      if (fixture) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    });

    try {
      await executeWindowsWindowCapability('windows.window.focus', {
        hwnd: fixture.hwnd,
        restore_if_minimized: true,
      });
    } catch (error) {
      if (
        errorCode(error) === 'WINDOW_FOCUS_NOT_VERIFIED' ||
        errorCode(error) === 'WINDOW_NOT_FOUND'
      ) {
        t.skip(
          'Runner session cannot foreground the isolated pointer fixture.',
        );
        return;
      }
      throw error;
    }

    const found = (await executeWindowsAccessibilityCapability(
      'windows.accessibility.find',
      {
        hwnd: fixture.hwnd,
        automation_id: 'NexowirePointerButton',
        max_results: 5,
        include_offscreen: true,
      },
    )) as {
      data: {
        matches: Array<{
          rect:
            | {
                x: number;
                y: number;
                width: number;
                height: number;
              }
            | null;
        }>;
      };
    };
    const rect = found.data.matches[0]?.rect;
    assert.ok(rect);

    const position = (await executeWindowsPointerCapability(
      'windows.pointer.position',
      { hwnd: fixture.hwnd },
    )) as {
      data: {
        clientOriginScreen: { x: number; y: number };
        clientSize: { width: number; height: number };
      };
    };

    const targetX = Math.round(
      rect.x +
        rect.width / 2 -
        position.data.clientOriginScreen.x,
    );
    const targetY = Math.round(
      rect.y +
        rect.height / 2 -
        position.data.clientOriginScreen.y,
    );

    assert.ok(targetX >= 0);
    assert.ok(targetY >= 0);
    assert.ok(targetX < position.data.clientSize.width);
    assert.ok(targetY < position.data.clientSize.height);

    let moved;
    try {
      moved = (await executeWindowsPointerCapability(
        'windows.pointer.move',
        {
          hwnd: fixture.hwnd,
          coordinate_mode: 'client_pixels',
          x: targetX,
          y: targetY,
        },
      )) as {
        data: {
          cursorVerified: boolean;
          targetHitVerified: boolean;
          clientPoint: { x: number; y: number };
        };
      };
    } catch (error) {
      if (
        [
          'WINDOW_NOT_FOREGROUND',
          'POINTER_TARGET_OCCLUDED',
          'POINTER_MOVE_NOT_VERIFIED',
          'POINTER_INPUT_FAILED',
        ].includes(errorCode(error) ?? '')
      ) {
        t.skip(
          'Runner session cannot inject pointer input into the isolated fixture: ' +
            (errorCode(error) ?? 'unknown') +
            (error instanceof Error ? ' - ' + error.message : ''),
        );
        return;
      }
      throw error;
    }

    assert.equal(moved.data.cursorVerified, true);
    assert.equal(moved.data.targetHitVerified, true);
    assert.equal(moved.data.clientPoint.x, targetX);
    assert.equal(moved.data.clientPoint.y, targetY);

    const afterMove = (await executeWindowsPointerCapability(
      'windows.pointer.position',
      { hwnd: fixture.hwnd },
    )) as {
      data: {
        insideClient: boolean;
        clientPoint: { x: number; y: number };
      };
    };
    assert.equal(afterMove.data.insideClient, true);
    assert.ok(Math.abs(afterMove.data.clientPoint.x - targetX) <= 1);
    assert.ok(Math.abs(afterMove.data.clientPoint.y - targetY) <= 1);

    const clicked = (await executeWindowsPointerCapability(
      'windows.pointer.click',
      {
        hwnd: fixture.hwnd,
        coordinate_mode: 'client_pixels',
        x: targetX,
        y: targetY,
        button: 'left',
        count: 1,
      },
    )) as {
      data: {
        ok: boolean;
        cursorVerified: boolean;
        targetHitVerified: boolean;
      };
    };
    assert.equal(clicked.data.ok, true);
    assert.equal(clicked.data.cursorVerified, true);
    assert.equal(clicked.data.targetHitVerified, true);

    const marker = await waitFor(async () => {
      try {
        return await fs.readFile(fixture!.marker, 'utf8');
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return undefined;
        }
        throw error;
      }
    });
    assert.equal(marker, 'clicked');

    const scrolled = (await executeWindowsPointerCapability(
      'windows.pointer.scroll',
      {
        hwnd: fixture.hwnd,
        coordinate_mode: 'normalized',
        x: 0.5,
        y: 0.5,
        delta: -120,
      },
    )) as {
      data: {
        ok: boolean;
        operation: string;
        delta: number;
      };
    };
    assert.equal(scrolled.data.ok, true);
    assert.equal(scrolled.data.operation, 'scroll');
    assert.equal(scrolled.data.delta, -120);
  },
);
