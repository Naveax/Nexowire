import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import {
  captureWindowsPrivateScreen,
} from './windows-private-screen.js';

const ViewerStartSchema = z.object({
  refresh_ms: z
    .number()
    .int()
    .min(250)
    .max(5_000)
    .default(750),
  max_width: z
    .number()
    .int()
    .min(320)
    .max(2_560)
    .default(1_280),
  max_height: z
    .number()
    .int()
    .min(240)
    .max(1_440)
    .default(720),
  max_bytes: z
    .number()
    .int()
    .min(262_144)
    .max(8_388_608)
    .default(4_194_304),
  topmost: z.boolean().default(false),
});

interface PrivateViewerState {
  version: 1;
  pid: number;
  startedAt: string;
  refreshMs: number;
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
  topmost: boolean;
  lastFrameAt: string | null;
  frameBytes: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  lastError: string | null;
}

class PrivateViewerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PrivateViewerError';
  }
}

let refreshTimer: NodeJS.Timeout | undefined;
let refreshGeneration = 0;
let refreshBusy = false;

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new PrivateViewerError(
      'WINDOWS_REQUIRED',
      'Nexowire private viewer requires Windows.',
    );
  }
}

function runtimeRoot(): string {
  return (
    process.env.NEXOWIRE_PRIVATE_VIEWER_DIR?.trim() ||
    path.join(
      os.homedir(),
      '.nexowire',
      'private-viewer',
    )
  );
}

function runtimePaths() {
  const root = runtimeRoot();
  return {
    root,
    state: path.join(root, 'state.json'),
    frame: path.join(root, 'frame.png'),
    heartbeat: path.join(root, 'heartbeat.txt'),
    viewer: path.join(root, 'viewer.ps1'),
  };
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readState(): Promise<
  PrivateViewerState | undefined
> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(runtimePaths().state, 'utf8'),
    ) as unknown;
    return z
      .object({
        version: z.literal(1),
        pid: z.number().int().positive(),
        startedAt: z.string().min(1),
        refreshMs: z.number().int().min(250).max(5_000),
        maxWidth: z.number().int().positive(),
        maxHeight: z.number().int().positive(),
        maxBytes: z.number().int().positive(),
        topmost: z.boolean(),
        lastFrameAt: z.string().nullable(),
        frameBytes: z.number().int().positive().nullable(),
        frameWidth: z.number().int().positive().nullable(),
        frameHeight: z.number().int().positive().nullable(),
        lastError: z.string().nullable(),
      })
      .parse(parsed) as PrivateViewerState;
  } catch {
    return undefined;
  }
}

async function writeState(
  state: PrivateViewerState,
): Promise<void> {
  const p = runtimePaths();
  await fs.mkdir(p.root, { recursive: true });
  const temp = p.state + '.tmp';
  await fs.writeFile(
    temp,
    JSON.stringify(state, null, 2) + '\n',
    'utf8',
  );
  await fs.rm(p.state, { force: true });
  await fs.rename(temp, p.state);
}

async function writeHeartbeat(): Promise<void> {
  const p = runtimePaths();
  await fs.writeFile(
    p.heartbeat,
    new Date().toISOString() + '\n',
    'utf8',
  );
}

async function heartbeatFresh(
  maxAgeMs = 20_000,
): Promise<boolean> {
  try {
    const stat = await fs.stat(
      runtimePaths().heartbeat,
    );
    return (
      Date.now() - stat.mtimeMs <= maxAgeMs
    );
  } catch {
    return false;
  }
}

async function writeFrame(
  base64: string,
): Promise<number> {
  const p = runtimePaths();
  const bytes = Buffer.from(base64, 'base64');
  const temp = p.frame + '.tmp';
  await fs.writeFile(temp, bytes);
  await fs.rm(p.frame, { force: true });
  await fs.rename(temp, p.frame);
  return bytes.length;
}

const viewerScript = String.raw`
param(
  [Parameter(Mandatory = $true)]
  [string]$FramePath,
  [Parameter(Mandatory = $true)]
  [string]$HeartbeatPath,
  [Parameter(Mandatory = $true)]
  [int]$RefreshMs,
  [Parameter(Mandatory = $true)]
  [int]$Topmost
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NxPrivateViewerDesktop {
  public const uint SWITCH = 0x0100;

  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr OpenDesktop(
    string name,
    int flags,
    bool inherit,
    uint access
  );

  [DllImport("user32.dll", SetLastError=true)]
  static extern bool SwitchDesktop(IntPtr desktop);

  [DllImport("user32.dll", SetLastError=true)]
  static extern bool CloseDesktop(IntPtr desktop);

  public static bool Enter(string name) {
    var desktop = OpenDesktop(
      name,
      0,
      false,
      SWITCH
    );
    if (desktop == IntPtr.Zero) return false;
    try {
      return SwitchDesktop(desktop);
    } finally {
      CloseDesktop(desktop);
    }
  }
}
"@

$window = New-Object System.Windows.Window
$window.Title = 'Nexowire Private Viewer'
$window.Width = 1280
$window.Height = 820
$window.MinWidth = 640
$window.MinHeight = 420
$window.WindowStartupLocation = 'CenterScreen'
$window.Background = [System.Windows.Media.Brushes]::Black
$window.Topmost = ($Topmost -eq 1)
$window.ShowInTaskbar = $true

$root = New-Object System.Windows.Controls.Grid
$rowTop = New-Object System.Windows.Controls.RowDefinition
$rowTop.Height = [System.Windows.GridLength]::Auto
$rowImage = New-Object System.Windows.Controls.RowDefinition
$rowImage.Height = New-Object System.Windows.GridLength(
  1,
  [System.Windows.GridUnitType]::Star
)
[void]$root.RowDefinitions.Add($rowTop)
[void]$root.RowDefinitions.Add($rowImage)

$bar = New-Object System.Windows.Controls.DockPanel
$bar.Background = (
  New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.Color]::FromRgb(22,24,31)
  )
)
$bar.LastChildFill = $true

$enter = New-Object System.Windows.Controls.Button
$enter.Content = 'ENTER PRIVATE DESKTOP'
$enter.Margin = '10'
$enter.Padding = '14,8,14,8'
$enter.HorizontalAlignment = 'Left'
$enter.ToolTip = 'Local user action: switch the physical display to NexowirePrivate.'
$enter.Add_Click({
  if (-not [NxPrivateViewerDesktop]::Enter('NexowirePrivate')) {
    [System.Windows.MessageBox]::Show(
      'NexowirePrivate is not available.',
      'Nexowire'
    ) | Out-Null
  }
})
[System.Windows.Controls.DockPanel]::SetDock(
  $enter,
  [System.Windows.Controls.Dock]::Left
)
[void]$bar.Children.Add($enter)

$close = New-Object System.Windows.Controls.Button
$close.Content = 'CLOSE VIEWER'
$close.Margin = '0,10,10,10'
$close.Padding = '14,8,14,8'
$close.HorizontalAlignment = 'Right'
$close.Add_Click({ $window.Close() })
[System.Windows.Controls.DockPanel]::SetDock(
  $close,
  [System.Windows.Controls.Dock]::Right
)
[void]$bar.Children.Add($close)

$status = New-Object System.Windows.Controls.TextBlock
$status.Text = 'NexowirePrivate live preview'
$status.Foreground = [System.Windows.Media.Brushes]::White
$status.VerticalAlignment = 'Center'
$status.Margin = '12,0,12,0'
[void]$bar.Children.Add($status)

[System.Windows.Controls.Grid]::SetRow($bar, 0)
[void]$root.Children.Add($bar)

$image = New-Object System.Windows.Controls.Image
$image.Stretch = [System.Windows.Media.Stretch]::Uniform
$image.HorizontalAlignment = 'Stretch'
$image.VerticalAlignment = 'Stretch'
$image.SnapsToDevicePixels = $true
[System.Windows.Controls.Grid]::SetRow($image, 1)
[void]$root.Children.Add($image)

$window.Content = $root
$lastFrameWrite = [datetime]::MinValue

function Load-Frame {
  if (-not (Test-Path -LiteralPath $FramePath)) {
    return
  }

  try {
    $item = Get-Item -LiteralPath $FramePath
    if ($item.LastWriteTimeUtc -le $lastFrameWrite) {
      return
    }

    $stream = [System.IO.File]::Open(
      $FramePath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite
    )
    try {
      $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
      $bitmap.BeginInit()
      $bitmap.CacheOption = (
        [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
      )
      $bitmap.StreamSource = $stream
      $bitmap.EndInit()
      $bitmap.Freeze()
      $image.Source = $bitmap
      $lastFrameWrite = $item.LastWriteTimeUtc
      $status.Text = (
        'NexowirePrivate live preview  •  ' +
        $bitmap.PixelWidth + '×' + $bitmap.PixelHeight +
        '  •  ' + [DateTime]::Now.ToString('HH:mm:ss')
      )
    } finally {
      $stream.Dispose()
    }
  } catch {
    # A frame may be between atomic replacement steps.
    # Keep the previous frame and retry on the next tick.
  }
}

function Heartbeat-Healthy {
  if (-not (Test-Path -LiteralPath $HeartbeatPath)) {
    return $false
  }
  try {
    $heartbeat = Get-Item -LiteralPath $HeartbeatPath
    return (
      ([DateTime]::UtcNow - $heartbeat.LastWriteTimeUtc).TotalSeconds
      -le 20
    )
  } catch {
    return $false
  }
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(
  [Math]::Max(100, $RefreshMs)
)
$timer.Add_Tick({
  if (-not (Heartbeat-Healthy)) {
    $window.Close()
    return
  }
  Load-Frame
})
$timer.Start()

$window.Add_Closed({ $timer.Stop() })
Load-Frame
[void]$window.ShowDialog()
`;

async function ensureViewerScript(): Promise<void> {
  const p = runtimePaths();
  await fs.mkdir(p.root, { recursive: true });
  await fs.writeFile(
    p.viewer,
    viewerScript,
    'utf8',
  );
}

async function captureAndPersist(
  state: PrivateViewerState,
): Promise<PrivateViewerState> {
  await writeHeartbeat();

  try {
    const capture = await captureWindowsPrivateScreen({
      source: 'desktop',
      max_width: state.maxWidth,
      max_height: state.maxHeight,
      max_bytes: state.maxBytes,
    });
    const frameBytes = await writeFrame(
      capture.data.base64,
    );
    return {
      ...state,
      lastFrameAt: new Date().toISOString(),
      frameBytes,
      frameWidth: capture.data.width,
      frameHeight: capture.data.height,
      lastError: null,
    };
  } catch (error) {
    return {
      ...state,
      lastError:
        error instanceof Error
          ? error.message.slice(0, 1024)
          : 'Private viewer capture failed.',
    };
  }
}

function stopRefreshLoop(): void {
  refreshGeneration++;
  refreshBusy = false;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

function startRefreshLoop(
  initial: PrivateViewerState,
): void {
  stopRefreshLoop();
  const generation = refreshGeneration;
  let state = initial;

  refreshTimer = setInterval(() => {
    if (
      generation !== refreshGeneration ||
      refreshBusy
    ) {
      return;
    }

    if (!processAlive(state.pid)) {
      stopRefreshLoop();
      void cleanupRuntime(false);
      return;
    }

    refreshBusy = true;
    void captureAndPersist(state)
      .then(async (next) => {
        state = next;
        await writeState(state);
      })
      .catch(() => {
        // Keep the viewer alive on a transient persistence error.
      })
      .finally(() => {
        refreshBusy = false;
      });
  }, initial.refreshMs);
  refreshTimer.unref?.();
}

async function cleanupRuntime(
  removeScript = false,
): Promise<void> {
  const p = runtimePaths();
  await Promise.all([
    fs.rm(p.state, { force: true }),
    fs.rm(p.frame, { force: true }),
    fs.rm(p.heartbeat, { force: true }),
    ...(removeScript
      ? [fs.rm(p.viewer, { force: true })]
      : []),
  ]);
}

async function viewerStatus(): Promise<{
  data: unknown;
}> {
  assertWindows();
  const state = await readState();
  const alive =
    state && processAlive(state.pid);
  const fresh =
    alive && (await heartbeatFresh());

  if (!state || !alive || !fresh) {
    if (state) {
      stopRefreshLoop();
      if (alive && !fresh) {
        try {
          process.kill(state.pid);
        } catch {
          // Best effort stale-viewer cleanup.
        }
      }
      await cleanupRuntime(false);
    }
    return {
      data: {
        running: false,
        localViewer: true,
      },
    };
  }

  const frameAgeMs = state.lastFrameAt
    ? Math.max(
        0,
        Date.now() -
          Date.parse(state.lastFrameAt),
      )
    : null;

  return {
    data: {
      running: true,
      localViewer: true,
      pid: state.pid,
      startedAt: state.startedAt,
      refreshMs: state.refreshMs,
      topmost: state.topmost,
      lastFrameAt: state.lastFrameAt,
      frameAgeMs,
      frameBytes: state.frameBytes,
      frameWidth: state.frameWidth,
      frameHeight: state.frameHeight,
      lastError: state.lastError,
      entryAction:
        'Local ENTER PRIVATE DESKTOP button',
      remoteInputInjected: false,
    },
  };
}

async function viewerStart(
  input: unknown,
): Promise<{ data: unknown }> {
  assertWindows();
  const parsed = ViewerStartSchema.parse(input);
  const existing = await readState();

  if (
    existing &&
    processAlive(existing.pid) &&
    (await heartbeatFresh())
  ) {
    return {
      data: {
        ...(await viewerStatus()).data as Record<
          string,
          unknown
        >,
        reused: true,
      },
    };
  }

  if (existing && processAlive(existing.pid)) {
    try {
      process.kill(existing.pid);
    } catch {
      // Best effort stale-viewer cleanup.
    }
  }

  stopRefreshLoop();
  await cleanupRuntime(false);
  await ensureViewerScript();

  let state: PrivateViewerState = {
    version: 1,
    pid: 0,
    startedAt: new Date().toISOString(),
    refreshMs: parsed.refresh_ms,
    maxWidth: parsed.max_width,
    maxHeight: parsed.max_height,
    maxBytes: parsed.max_bytes,
    topmost: parsed.topmost,
    lastFrameAt: null,
    frameBytes: null,
    frameWidth: null,
    frameHeight: null,
    lastError: null,
  };

  state = await captureAndPersist(state);
  if (!state.lastFrameAt) {
    throw new PrivateViewerError(
      'PRIVATE_VIEWER_INITIAL_CAPTURE_FAILED',
      state.lastError ||
        'Could not capture the first private-desktop frame.',
    );
  }

  const p = runtimePaths();
  const child = spawn(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      p.viewer,
      '-FramePath',
      p.frame,
      '-HeartbeatPath',
      p.heartbeat,
      '-RefreshMs',
      String(parsed.refresh_ms),
      '-Topmost',
      parsed.topmost ? '1' : '0',
    ],
    {
      windowsHide: false,
      detached: false,
      stdio: 'ignore',
    },
  );

  if (!child.pid) {
    throw new PrivateViewerError(
      'PRIVATE_VIEWER_START_FAILED',
      'Windows did not return a viewer process id.',
    );
  }

  state = {
    ...state,
    pid: child.pid,
  };
  await writeState(state);

  await new Promise((resolve) =>
    setTimeout(resolve, 400),
  );
  if (!processAlive(child.pid)) {
    await cleanupRuntime(false);
    throw new PrivateViewerError(
      'PRIVATE_VIEWER_EXITED_EARLY',
      'Nexowire Private Viewer exited during startup.',
    );
  }

  child.once('exit', () => {
    stopRefreshLoop();
    void cleanupRuntime(false);
  });

  startRefreshLoop(state);

  return {
    data: {
      ...(await viewerStatus()).data as Record<
        string,
        unknown
      >,
      reused: false,
    },
  };
}

async function viewerStop(): Promise<{
  data: unknown;
}> {
  assertWindows();
  stopRefreshLoop();
  const state = await readState();
  let stopped = false;

  if (state && processAlive(state.pid)) {
    try {
      process.kill(state.pid);
      stopped = true;
    } catch {
      // Status verification below remains authoritative.
    }
  }

  if (state) {
    const deadline = Date.now() + 3_000;
    while (
      processAlive(state.pid) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, 50),
      );
    }
    if (processAlive(state.pid)) {
      throw new PrivateViewerError(
        'PRIVATE_VIEWER_STOP_NOT_VERIFIED',
        'Private viewer process did not exit.',
        { pid: state.pid },
      );
    }
  }

  await cleanupRuntime(false);
  return {
    data: {
      running: false,
      stopped,
      localViewer: true,
    },
  };
}

export async function executeWindowsPrivateViewerCapability(
  capability: string,
  input: unknown,
): Promise<unknown> {
  switch (capability) {
    case 'windows.private_viewer.status':
      return await viewerStatus();
    case 'windows.private_viewer.start':
      return await viewerStart(input);
    case 'windows.private_viewer.stop':
      return await viewerStop();
    default:
      throw new PrivateViewerError(
        'UNSUPPORTED',
        'Unsupported private viewer capability: ' +
          capability,
      );
  }
}
