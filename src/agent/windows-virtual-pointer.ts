import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';

const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((value) => value.toUpperCase());

const PointerStyleSchema = z.object({
  color: HexColorSchema.default('#00D8FF'),
  size: z.number().int().min(16).max(96).default(34),
  opacity: z.number().min(0.2).max(1).default(0.92),
  label: z.string().min(1).max(24).default('NX'),
});

const PointerStartSchema = PointerStyleSchema.partial().extend({
  x: z.number().int().min(-100_000).max(100_000).optional(),
  y: z.number().int().min(-100_000).max(100_000).optional(),
  visible: z.boolean().default(true),
});

const PointerMoveSchema = z.object({
  x: z.number().int().min(-100_000).max(100_000),
  y: z.number().int().min(-100_000).max(100_000),
  visible: z.boolean().optional(),
});

const PointerStyleInputSchema = PointerStyleSchema.partial();

const PointerVisibilitySchema = z.object({
  visible: z.boolean(),
});

interface VirtualPointerState {
  version: 1;
  x: number;
  y: number;
  visible: boolean;
  color: string;
  size: number;
  opacity: number;
  label: string;
  updatedAt: string;
}

class WindowsVirtualPointerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WindowsVirtualPointerError';
  }
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new WindowsVirtualPointerError(
      'WINDOWS_REQUIRED',
      'Nexowire virtual pointer requires a Windows native agent.',
    );
  }
}

function runtimeRoot(): string {
  return (
    process.env.NEXOWIRE_VIRTUAL_POINTER_DIR?.trim() ||
    path.join(os.homedir(), '.nexowire', 'virtual-pointer')
  );
}

function runtimePaths(): {
  root: string;
  state: string;
  pid: string;
  overlay: string;
} {
  const root = runtimeRoot();
  return {
    root,
    state: path.join(root, 'state.json'),
    pid: path.join(root, 'overlay.pid'),
    overlay: path.join(root, 'overlay.ps1'),
  };
}

function defaultState(): VirtualPointerState {
  return {
    version: 1,
    x: 120,
    y: 120,
    visible: true,
    color: '#00D8FF',
    size: 34,
    opacity: 0.92,
    label: 'NX',
    updatedAt: new Date().toISOString(),
  };
}

async function readState(): Promise<VirtualPointerState> {
  const { state } = runtimePaths();
  try {
    const parsed = JSON.parse(await fs.readFile(state, 'utf8')) as unknown;
    return z
      .object({
        version: z.literal(1),
        x: z.number().int(),
        y: z.number().int(),
        visible: z.boolean(),
        color: HexColorSchema,
        size: z.number().int().min(16).max(96),
        opacity: z.number().min(0.2).max(1),
        label: z.string().min(1).max(24),
        updatedAt: z.string(),
      })
      .parse(parsed) as VirtualPointerState;
  } catch {
    return defaultState();
  }
}

async function writeState(state: VirtualPointerState): Promise<void> {
  const paths = runtimePaths();
  await fs.mkdir(paths.root, { recursive: true });
  const temp = paths.state + '.tmp';
  await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.rename(temp, paths.state);
}

async function readPid(): Promise<number | undefined> {
  try {
    const raw = (await fs.readFile(runtimePaths().pid, 'utf8')).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const overlayScript = String.raw`
param(
  [Parameter(Mandatory = $true)]
  [string]$StateFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

if (-not ('NexowireOverlayNative' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NexowireOverlayNative {
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TRANSPARENT = 0x00000020;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public const int WS_EX_LAYERED = 0x00080000;

  [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
  public static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
  public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
  public static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
  public static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

  public static IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex) {
    return IntPtr.Size == 8
      ? GetWindowLongPtr64(hWnd, nIndex)
      : new IntPtr(GetWindowLong32(hWnd, nIndex));
  }

  public static void SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr value) {
    if (IntPtr.Size == 8) {
      SetWindowLongPtr64(hWnd, nIndex, value);
    } else {
      SetWindowLong32(hWnd, nIndex, value.ToInt32());
    }
  }
}
"@
}

$window = New-Object System.Windows.Window
$window.Title = 'Nexowire Virtual Pointer Overlay'
$window.WindowStyle = [System.Windows.WindowStyle]::None
$window.ResizeMode = [System.Windows.ResizeMode]::NoResize
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ShowActivated = $false
$window.Focusable = $false
$window.Left = [System.Windows.SystemParameters]::VirtualScreenLeft
$window.Top = [System.Windows.SystemParameters]::VirtualScreenTop
$window.Width = [System.Windows.SystemParameters]::VirtualScreenWidth
$window.Height = [System.Windows.SystemParameters]::VirtualScreenHeight

$canvas = New-Object System.Windows.Controls.Canvas
$canvas.Background = [System.Windows.Media.Brushes]::Transparent
$canvas.IsHitTestVisible = $false

$cursor = New-Object System.Windows.Shapes.Path
$cursor.IsHitTestVisible = $false
$cursor.StrokeThickness = 1.5
$cursor.Data = [System.Windows.Media.Geometry]::Parse(
  'M 1,1 L 1,25 L 7.2,19 L 11.5,29 L 16.4,26.7 L 12.1,17.2 L 21,17.2 Z'
)

$badge = New-Object System.Windows.Controls.Border
$badge.IsHitTestVisible = $false
$badge.CornerRadius = New-Object System.Windows.CornerRadius(4)
$badge.Padding = New-Object System.Windows.Thickness(4,1,4,1)
$badge.BorderThickness = New-Object System.Windows.Thickness(1)

$label = New-Object System.Windows.Controls.TextBlock
$label.FontFamily = 'Segoe UI'
$label.FontWeight = [System.Windows.FontWeights]::SemiBold
$label.FontSize = 10
$badge.Child = $label

[void]$canvas.Children.Add($cursor)
[void]$canvas.Children.Add($badge)
$window.Content = $canvas

$window.Add_SourceInitialized({
  $helper = New-Object System.Windows.Interop.WindowInteropHelper($window)
  $hwnd = $helper.Handle
  $style = [NexowireOverlayNative]::GetWindowLongPtr(
    $hwnd,
    [NexowireOverlayNative]::GWL_EXSTYLE
  ).ToInt64()
  $style = $style -bor [NexowireOverlayNative]::WS_EX_TRANSPARENT
  $style = $style -bor [NexowireOverlayNative]::WS_EX_TOOLWINDOW
  $style = $style -bor [NexowireOverlayNative]::WS_EX_NOACTIVATE
  $style = $style -bor [NexowireOverlayNative]::WS_EX_LAYERED
  [NexowireOverlayNative]::SetWindowLongPtr(
    $hwnd,
    [NexowireOverlayNative]::GWL_EXSTYLE,
    [IntPtr]::new($style)
  )
})

$lastWrite = [datetime]::MinValue

function Apply-State {
  if (-not (Test-Path -LiteralPath $StateFile)) {
    return
  }

  $item = Get-Item -LiteralPath $StateFile
  if ($item.LastWriteTimeUtc -le $lastWrite) {
    return
  }

  try {
    $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    $lastWrite = $item.LastWriteTimeUtc

    $brush = [System.Windows.Media.BrushConverter]::new().ConvertFromString(
      [string]$state.color
    )

    $cursor.Fill = $brush
    $cursor.Stroke = [System.Windows.Media.Brushes]::White
    $cursor.Opacity = [double]$state.opacity

    $scale = [double]$state.size / 34.0
    $cursor.RenderTransform = New-Object System.Windows.Media.ScaleTransform(
      $scale,
      $scale
    )

    $label.Text = [string]$state.label
    $label.Foreground = [System.Windows.Media.Brushes]::Black
    $badge.Background = $brush
    $badge.BorderBrush = [System.Windows.Media.Brushes]::White
    $badge.Opacity = [double]$state.opacity

    $localX = [double]$state.x - [System.Windows.SystemParameters]::VirtualScreenLeft
    $localY = [double]$state.y - [System.Windows.SystemParameters]::VirtualScreenTop

    [System.Windows.Controls.Canvas]::SetLeft($cursor, $localX)
    [System.Windows.Controls.Canvas]::SetTop($cursor, $localY)
    [System.Windows.Controls.Canvas]::SetLeft(
      $badge,
      $localX + [Math]::Max(18, [double]$state.size * 0.62)
    )
    [System.Windows.Controls.Canvas]::SetTop(
      $badge,
      $localY + [Math]::Max(18, [double]$state.size * 0.54)
    )

    $visibility = if ([bool]$state.visible) {
      [System.Windows.Visibility]::Visible
    } else {
      [System.Windows.Visibility]::Collapsed
    }
    $cursor.Visibility = $visibility
    $badge.Visibility = $visibility
  } catch {
    # Ignore partially-written or temporarily unavailable state and retry.
  }
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(25)
$timer.Add_Tick({ Apply-State })
$timer.Start()

Apply-State
$window.Show()
[System.Windows.Threading.Dispatcher]::Run()
`;

async function ensureOverlayScript(): Promise<void> {
  const paths = runtimePaths();
  await fs.mkdir(paths.root, { recursive: true });
  await fs.writeFile(paths.overlay, overlayScript, 'utf8');
}

async function startOverlay(input: unknown): Promise<{ data: unknown }> {
  assertWindows();
  const parsed = PointerStartSchema.parse(input);
  const paths = runtimePaths();

  const existingPid = await readPid();
  let state = await readState();
  state = {
    ...state,
    ...(parsed.x !== undefined ? { x: parsed.x } : {}),
    ...(parsed.y !== undefined ? { y: parsed.y } : {}),
    ...(parsed.color !== undefined ? { color: parsed.color } : {}),
    ...(parsed.size !== undefined ? { size: parsed.size } : {}),
    ...(parsed.opacity !== undefined ? { opacity: parsed.opacity } : {}),
    ...(parsed.label !== undefined ? { label: parsed.label } : {}),
    visible: parsed.visible,
    updatedAt: new Date().toISOString(),
  };
  await writeState(state);

  if (processAlive(existingPid)) {
    return {
      data: {
        running: true,
        pid: existingPid,
        reused: true,
        state,
        touchesSystemCursor: false,
        clickThrough: true,
      },
    };
  }

  await ensureOverlayScript();
  const child = spawn(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-File',
      paths.overlay,
      paths.state,
    ],
    {
      detached: false,
      windowsHide: true,
      cwd: paths.root,
      stdio: 'ignore',
    },
  );

  if (!child.pid) {
    throw new WindowsVirtualPointerError(
      'VIRTUAL_POINTER_START_FAILED',
      'Windows did not return a process id for the Nexowire pointer overlay.',
    );
  }

  await fs.writeFile(paths.pid, String(child.pid) + '\n', 'utf8');
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 750));

  if (!processAlive(child.pid)) {
    await fs.rm(paths.pid, { force: true });
    throw new WindowsVirtualPointerError(
      'VIRTUAL_POINTER_START_FAILED',
      'Nexowire pointer overlay exited during startup.',
    );
  }

  return {
    data: {
      running: true,
      pid: child.pid,
      reused: false,
      state,
      touchesSystemCursor: false,
      clickThrough: true,
    },
  };
}

async function stopOverlay(): Promise<{ data: unknown }> {
  assertWindows();
  const paths = runtimePaths();
  const pid = await readPid();
  let stopped = false;

  if (pid && processAlive(pid)) {
    try {
      process.kill(pid);
      stopped = true;
    } catch (error) {
      throw new WindowsVirtualPointerError(
        'VIRTUAL_POINTER_STOP_FAILED',
        'Failed to stop the Nexowire pointer overlay.',
        {
          pid,
          nativeMessage:
            error instanceof Error ? error.message : String(error),
        },
      );
    }

    const deadline = Date.now() + 3_000;
    while (processAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (processAlive(pid)) {
      throw new WindowsVirtualPointerError(
        'VIRTUAL_POINTER_STOP_NOT_VERIFIED',
        'The Nexowire pointer overlay did not exit after the stop request.',
        { pid },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await fs.rm(paths.pid, { force: true });
  return {
    data: {
      running: false,
      pid: pid ?? null,
      stopped,
    },
  };
}

async function moveOverlay(input: unknown): Promise<{ data: unknown }> {
  assertWindows();
  const parsed = PointerMoveSchema.parse(input);
  const current = await readState();
  const next: VirtualPointerState = {
    ...current,
    x: parsed.x,
    y: parsed.y,
    ...(parsed.visible !== undefined ? { visible: parsed.visible } : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeState(next);

  return {
    data: {
      running: processAlive(await readPid()),
      state: next,
      touchesSystemCursor: false,
    },
  };
}

async function styleOverlay(input: unknown): Promise<{ data: unknown }> {
  assertWindows();
  const parsed = PointerStyleInputSchema.parse(input);
  if (Object.keys(parsed).length === 0) {
    throw new WindowsVirtualPointerError(
      'VIRTUAL_POINTER_STYLE_EMPTY',
      'At least one style field must be supplied.',
    );
  }

  const current = await readState();
  const next: VirtualPointerState = {
    ...current,
    ...parsed,
    updatedAt: new Date().toISOString(),
  };
  await writeState(next);

  return {
    data: {
      running: processAlive(await readPid()),
      state: next,
    },
  };
}

async function setVisibility(input: unknown): Promise<{ data: unknown }> {
  assertWindows();
  const parsed = PointerVisibilitySchema.parse(input);
  const current = await readState();
  const next: VirtualPointerState = {
    ...current,
    visible: parsed.visible,
    updatedAt: new Date().toISOString(),
  };
  await writeState(next);
  return {
    data: {
      running: processAlive(await readPid()),
      state: next,
    },
  };
}

async function statusOverlay(): Promise<{ data: unknown }> {
  assertWindows();
  const pid = await readPid();
  return {
    data: {
      running: processAlive(pid),
      pid: pid ?? null,
      state: await readState(),
      touchesSystemCursor: false,
      clickThrough: true,
      isolation: 'visual-pointer-only',
    },
  };
}

export async function executeWindowsVirtualPointerCapability(
  capability: string,
  input: unknown,
): Promise<unknown> {
  switch (capability) {
    case 'windows.virtual_pointer.status':
      return await statusOverlay();
    case 'windows.virtual_pointer.start':
      return await startOverlay(input);
    case 'windows.virtual_pointer.stop':
      return await stopOverlay();
    case 'windows.virtual_pointer.move':
      return await moveOverlay(input);
    case 'windows.virtual_pointer.style':
      return await styleOverlay(input);
    case 'windows.virtual_pointer.visibility':
      return await setVisibility(input);
    default:
      throw new WindowsVirtualPointerError(
        'VIRTUAL_POINTER_UNSUPPORTED',
        'Unsupported Windows virtual pointer capability: ' + capability,
      );
  }
}
