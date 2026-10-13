import { spawn } from 'node:child_process';
import * as z from 'zod';

const DESKTOP_NAME = 'NexowirePrivate';

const WindowHandleSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/);

const PrivateScreenSchema = z
  .object({
    source: z
      .enum(['desktop', 'monitor', 'window'])
      .default('desktop'),
    monitor_index: z.number().int().min(0).max(15).optional(),
    monitor_id: z.string().min(1).max(128).optional(),
    hwnd: WindowHandleSchema.optional(),
    max_width: z
      .number()
      .int()
      .min(160)
      .max(7680)
      .default(1920),
    max_height: z
      .number()
      .int()
      .min(120)
      .max(4320)
      .default(1080),
    max_bytes: z
      .number()
      .int()
      .min(65_536)
      .max(8_388_608)
      .default(4_194_304),
  })
  .superRefine((value, ctx) => {
    if (
      value.source === 'window' &&
      !value.hwnd
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['hwnd'],
        message:
          'hwnd is required when source=window.',
      });
    }
    if (value.source !== 'window' && value.hwnd) {
      ctx.addIssue({
        code: 'custom', path: ['hwnd'],
        message: 'hwnd requires source=window.',
      });
    }
    const hasMonitor = value.monitor_index !== undefined || value.monitor_id !== undefined;
    if (value.source === 'monitor' && !hasMonitor) {
      ctx.addIssue({
        code: 'custom', path: ['monitor_index'],
        message: 'source=monitor requires monitor_index or monitor_id.',
      });
    }
    if (value.source !== 'monitor' && hasMonitor) {
      ctx.addIssue({
        code: 'custom', path: ['monitor_index'],
        message: 'A monitor selector requires source=monitor.',
      });
    }
    if (value.monitor_index !== undefined && value.monitor_id !== undefined) {
      ctx.addIssue({
        code: 'custom', path: ['monitor_id'],
        message: 'Select a monitor by index or ID, not both.',
      });
    }
  });

export function parseWindowsPrivateScreenCaptureRequest(input:unknown): z.infer<typeof PrivateScreenSchema> {
  return PrivateScreenSchema.parse(input);
}

class PrivateScreenError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PrivateScreenError';
  }
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new PrivateScreenError(
      'WINDOWS_REQUIRED',
      'Nexowire private-screen capture requires Windows.',
    );
  }
}

const captureScript = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class NxPrivateScreenNative {
  public const uint READ = 0x0001;
  public const uint ENUM = 0x0040;
  public const uint SWITCH = 0x0100;
  public const int UOI_NAME = 2;
  public const uint PW_RENDERFULLCONTENT = 0x00000002;
  public const uint MONITOR_DEFAULTTONEAREST = 2;

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll")]
  static extern IntPtr MonitorFromPoint(POINT point, uint flags);

  [DllImport("shcore.dll")]
  static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint x, out uint y);

  [DllImport("shcore.dll")]
  static extern int SetProcessDpiAwareness(int awareness);

  // Use physical monitor pixels consistently for Screen.Bounds + GetWindowRect.
  // This affects only the short-lived screenshot helper, never the owner session.
  public static bool TryEnablePerMonitorDpi() {
    try { return SetProcessDpiAwareness(2) == 0; }
    catch { return false; }
  }

  public static int[] MonitorDpi(int x, int y) {
    try {
      var monitor = MonitorFromPoint(new POINT { X = x, Y = y }, MONITOR_DEFAULTTONEAREST);
      if (monitor == IntPtr.Zero) return new int[] { 0, 0 };
      uint dpiX, dpiY;
      int hr = GetDpiForMonitor(monitor, 0, out dpiX, out dpiY);
      if (hr != 0) return new int[] { 0, 0 };
      return new int[] { checked((int)dpiX), checked((int)dpiY) };
    } catch { return new int[] { 0, 0 }; }
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public sealed class WindowInfo {
    public string Hwnd;
    public string Title;
    public bool Visible;
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr OpenDesktop(
    string name,
    int flags,
    bool inherit,
    uint access
  );

  [DllImport("user32.dll", SetLastError=true)]
  static extern bool CloseDesktop(IntPtr desktop);

  [DllImport("user32.dll", SetLastError=true)]
  static extern bool EnumDesktopWindows(
    IntPtr desktop,
    EnumProc callback,
    IntPtr lParam
  );

  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hwnd);

  [DllImport("user32.dll")]
  static extern bool GetWindowRect(
    IntPtr hwnd,
    out RECT rect
  );

  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  static extern int GetWindowTextLength(IntPtr hwnd);

  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  static extern int GetWindowText(
    IntPtr hwnd,
    StringBuilder value,
    int maxCount
  );

  [DllImport("user32.dll", SetLastError=true)]
  static extern bool PrintWindow(
    IntPtr hwnd,
    IntPtr hdc,
    uint flags
  );

  [DllImport("user32.dll")]
  static extern IntPtr SendMessage(
    IntPtr hwnd,
    uint message,
    IntPtr wParam,
    IntPtr lParam
  );

  [DllImport("user32.dll", SetLastError=true)]
  static extern IntPtr OpenInputDesktop(
    uint flags,
    bool inherit,
    uint access
  );

  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetUserObjectInformation(
    IntPtr handle,
    int index,
    StringBuilder value,
    int length,
    out int needed
  );

  public static WindowInfo[] Windows(
    string desktopName
  ) {
    var desktop = OpenDesktop(
      desktopName,
      0,
      false,
      READ | ENUM
    );
    if (desktop == IntPtr.Zero) {
      throw new System.ComponentModel.Win32Exception(
        Marshal.GetLastWin32Error(),
        "PRIVATE_DESKTOP_NOT_RUNNING"
      );
    }

    var windows = new List<WindowInfo>();
    try {
      EnumProc callback = delegate(
        IntPtr hwnd,
        IntPtr ignored
      ) {
        RECT rect;
        if (!GetWindowRect(hwnd, out rect)) {
          return true;
        }
        var length = Math.Min(
          GetWindowTextLength(hwnd),
          4096
        );
        var title = new StringBuilder(length + 1);
        GetWindowText(
          hwnd,
          title,
          title.Capacity
        );
        windows.Add(new WindowInfo {
          Hwnd =
            "0x" + hwnd.ToInt64().ToString("X"),
          Title = title.ToString(),
          Visible = IsWindowVisible(hwnd),
          Left = rect.Left,
          Top = rect.Top,
          Right = rect.Right,
          Bottom = rect.Bottom
        });
        return true;
      };
      if (!EnumDesktopWindows(
        desktop,
        callback,
        IntPtr.Zero
      )) {
        throw new System.ComponentModel.Win32Exception(
          Marshal.GetLastWin32Error()
        );
      }
      return windows.ToArray();
    } finally {
      CloseDesktop(desktop);
    }
  }

  public static bool Print(
    string rawHwnd,
    IntPtr hdc
  ) {
    long value = rawHwnd.StartsWith(
      "0x",
      StringComparison.OrdinalIgnoreCase
    )
      ? Convert.ToInt64(rawHwnd.Substring(2), 16)
      : Convert.ToInt64(rawHwnd, 10);

    var hwnd = new IntPtr(value);
    if (PrintWindow(
      hwnd,
      hdc,
      PW_RENDERFULLCONTENT
    )) {
      return true;
    }

    const uint WM_PRINT = 0x0317;
    const int PRF_CHECKVISIBLE = 0x00000001;
    const int PRF_NONCLIENT = 0x00000002;
    const int PRF_CLIENT = 0x00000004;
    const int PRF_ERASEBKGND = 0x00000008;
    const int PRF_CHILDREN = 0x00000010;
    const int PRF_OWNED = 0x00000020;
    SendMessage(
      hwnd,
      WM_PRINT,
      hdc,
      new IntPtr(
        PRF_CHECKVISIBLE |
        PRF_NONCLIENT |
        PRF_CLIENT |
        PRF_ERASEBKGND |
        PRF_CHILDREN |
        PRF_OWNED
      )
    );
    return true;
  }

  static string Name(IntPtr handle) {
    int needed;
    GetUserObjectInformation(
      handle,
      UOI_NAME,
      null,
      0,
      out needed
    );
    if (needed <= 0) return "";
    var value =
      new StringBuilder(needed / 2 + 2);
    return GetUserObjectInformation(
      handle,
      UOI_NAME,
      value,
      value.Capacity * 2,
      out needed
    )
      ? value.ToString()
      : "";
  }

  public static string InputDesktop() {
    var desktop = OpenInputDesktop(
      0,
      false,
      READ | SWITCH
    );
    if (desktop == IntPtr.Zero) {
      return "";
    }
    try {
      return Name(desktop);
    } finally {
      CloseDesktop(desktop);
    }
  }
}
"@

function Capture-PrivateWindow {
  param($Entry)

  $width = [Math]::Max(
    0,
    [int]$Entry.Right - [int]$Entry.Left
  )
  $height = [Math]::Max(
    0,
    [int]$Entry.Bottom - [int]$Entry.Top
  )
  if ($width -le 0 -or $height -le 0) {
    return $null
  }

  $bitmap = New-Object System.Drawing.Bitmap(
    $width,
    $height,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $graphics =
    [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = [IntPtr]::Zero
  try {
    $hdc = $graphics.GetHdc()
    $ok = [NxPrivateScreenNative]::Print(
      [string]$Entry.Hwnd,
      $hdc
    )
  } finally {
    if ($hdc -ne [IntPtr]::Zero) {
      $graphics.ReleaseHdc($hdc)
    }
    $graphics.Dispose()
  }

  if (-not $ok) {
    $bitmap.Dispose()
    return $null
  }

  return $bitmap
}

$inputData =
  $env:NEXOWIRE_PRIVATE_SCREEN_INPUT |
  ConvertFrom-Json

$source = [string]$inputData.source
# Win32 desktop objects SHARE host monitor topology. These are connected
# native monitors, never independently created AI virtual monitors.
$dpiAwarenessApplied = [NxPrivateScreenNative]::TryEnablePerMonitorDpi()
$hostScreens = @([System.Windows.Forms.Screen]::AllScreens)
$displays = @(
  for($idx=0;$idx -lt $hostScreens.Count;$idx++) {
    $screen = $hostScreens[$idx]
    $rectangle = $screen.Bounds
    $effectiveDpi = [NxPrivateScreenNative]::MonitorDpi(
      ($rectangle.X + [int]($rectangle.Width / 2)),
      ($rectangle.Y + [int]($rectangle.Height / 2))
    )
    [pscustomobject]@{
      index = $idx
      id = [string]$screen.DeviceName
      x = [int]$rectangle.X
      y = [int]$rectangle.Y
      width = [int]$rectangle.Width
      height = [int]$rectangle.Height
      primary = [bool]$screen.Primary
      effectiveDpiX = $(if($effectiveDpi[0] -gt 0){$effectiveDpi[0]}else{$null})
      effectiveDpiY = $(if($effectiveDpi[1] -gt 0){$effectiveDpi[1]}else{$null})
    }
  }
)
# Metadata-only read: works even before NexowirePrivate is started, and
# does not require any private GUI window or allocate a screenshot bitmap.
if($source -eq 'topology') {
  $before = [NxPrivateScreenNative]::InputDesktop()
  $virtualBounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $after = [NxPrivateScreenNative]::InputDesktop()
  [pscustomobject]@{
    ok = $true
    topologyKind = 'host_shared_native'
    independentAiDisplays = $false
    monitorCount = $displays.Count
    monitors = @($displays)
    virtualBounds = [pscustomobject]@{
      x=[int]$virtualBounds.X; y=[int]$virtualBounds.Y
      width=[int]$virtualBounds.Width; height=[int]$virtualBounds.Height
    }
    perMonitorDpiAwarenessApplied = $dpiAwarenessApplied
    capturedAt = [DateTime]::UtcNow.ToString('o')
    inputDesktopBefore = $before
    inputDesktopAfter = $after
    visibleDesktopChanged = ($before -ne $after)
  } | ConvertTo-Json -Depth 5 -Compress
  exit 0
}
$selectedMonitor = $null
if($source -eq 'monitor') {
  if($null -ne $inputData.monitor_index) {
    $selectedMonitor = @($displays | Where-Object { $_.index -eq [int]$inputData.monitor_index }) | Select-Object -First 1
  } else {
    $selectedMonitor = @($displays | Where-Object { $_.id -ieq [string]$inputData.monitor_id }) | Select-Object -First 1
  }
  if($null -eq $selectedMonitor) {
    [pscustomobject]@{
      ok = $false
      code = 'PRIVATE_MONITOR_NOT_FOUND'
      message = 'Requested monitor is not in the current host display topology.'
    } | ConvertTo-Json -Compress
    exit 7
  }
}
$maxWidth = [int]$inputData.max_width
$maxHeight = [int]$inputData.max_height
$maxBytes = [int64]$inputData.max_bytes
$before =
  [NxPrivateScreenNative]::InputDesktop()
$windows =
  @([NxPrivateScreenNative]::Windows(
    'NexowirePrivate'
  ))

$sourceBitmap = $null
$targetBitmap = $null
$targetGraphics = $null
$stream = $null
$captured = 0
$failed = 0
$resolvedHwnd = $null
$windowTitle = $null

try {
  if ($source -eq 'window') {
    $wanted =
      ([string]$inputData.hwnd).ToUpperInvariant()
    $entry = $windows |
      Where-Object {
        ([string]$_.Hwnd).ToUpperInvariant() -eq
          $wanted
      } |
      Select-Object -First 1

    if ($null -eq $entry) {
      [pscustomobject]@{
        ok = $false
        code = 'WINDOW_NOT_PRIVATE_DESKTOP'
        message =
          'The requested HWND is not a top-level window on NexowirePrivate.'
      } | ConvertTo-Json -Compress
      exit 3
    }

    $sourceBitmap =
      Capture-PrivateWindow $entry
    if ($null -eq $sourceBitmap) {
      [pscustomobject]@{
        ok = $false
        code = 'PRIVATE_WINDOW_RENDER_FAILED'
        message =
          'PrintWindow could not render the requested private HWND.'
        hwnd = [string]$entry.Hwnd
      } | ConvertTo-Json -Compress
      exit 4
    }
    $captured = 1
    $resolvedHwnd = [string]$entry.Hwnd
    $windowTitle = [string]$entry.Title
  } elseif ($source -eq 'desktop' -or $source -eq 'monitor') {
    if($source -eq 'monitor') {
      $bounds = [System.Drawing.Rectangle]::new(
        $selectedMonitor.x, $selectedMonitor.y,
        $selectedMonitor.width, $selectedMonitor.height
      )
    } else {
      # Default captures all connected monitors, including negative coordinates.
      $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    }
    if([long]$bounds.Width * [long]$bounds.Height -gt 120000000) {
      [pscustomobject]@{
        ok = $false
        code = 'PRIVATE_SCREEN_SOURCE_TOO_LARGE'
        message = 'Desktop bitmap exceeds the 120-megapixel limit; select a monitor.'
      } | ConvertTo-Json -Compress
      exit 8
    }
    $sourceBitmap =
      New-Object System.Drawing.Bitmap(
        $bounds.Width,
        $bounds.Height,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
      )
    $desktopGraphics =
      [System.Drawing.Graphics]::FromImage(
        $sourceBitmap
      )
    try {
      $desktopGraphics.Clear(
        [System.Drawing.Color]::FromArgb(
          255,
          16,
          18,
          24
        )
      )

      $visibleWindows = @(
        $windows |
          Where-Object {
            $_.Visible -and
            ([int]$_.Right - [int]$_.Left) -gt 0 -and
            ([int]$_.Bottom - [int]$_.Top) -gt 0 -and
            [int]$_.Right -gt [int]$bounds.Left -and
            [int]$_.Left -lt [int]$bounds.Right -and
            [int]$_.Bottom -gt [int]$bounds.Top -and
            [int]$_.Top -lt [int]$bounds.Bottom
          }
      )

      for (
        $i = $visibleWindows.Count - 1;
        $i -ge 0;
        $i--
      ) {
        $entry = $visibleWindows[$i]
        $bitmap =
          Capture-PrivateWindow $entry
        if ($null -eq $bitmap) {
          $failed++
          continue
        }
        try {
          $x =
            [int]$entry.Left - $bounds.X
          $y =
            [int]$entry.Top - $bounds.Y
          $desktopGraphics.DrawImageUnscaled(
            $bitmap,
            $x,
            $y
          )
          $captured++
        } finally {
          $bitmap.Dispose()
        }
      }
    } finally {
      $desktopGraphics.Dispose()
    }

    if ($captured -lt 1) {
      [pscustomobject]@{
        ok = $false
        code = 'PRIVATE_DESKTOP_RENDER_FAILED'
        message =
          'No visible NexowirePrivate window could be rendered.'
        failedWindows = $failed
      } | ConvertTo-Json -Compress
      exit 5
    }
  } else {
    throw 'Unsupported private-screen source.'
  }

  $sourceWidth = $sourceBitmap.Width
  $sourceHeight = $sourceBitmap.Height
  $scale = [Math]::Min(
    1.0,
    [Math]::Min(
      $maxWidth / [double]$sourceWidth,
      $maxHeight / [double]$sourceHeight
    )
  )
  $targetWidth = [Math]::Max(
    1,
    [int][Math]::Round(
      $sourceWidth * $scale
    )
  )
  $targetHeight = [Math]::Max(
    1,
    [int][Math]::Round(
      $sourceHeight * $scale
    )
  )

  if (
    $targetWidth -ne $sourceWidth -or
    $targetHeight -ne $sourceHeight
  ) {
    $targetBitmap =
      New-Object System.Drawing.Bitmap(
        $targetWidth,
        $targetHeight,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
      )
    $targetGraphics =
      [System.Drawing.Graphics]::FromImage(
        $targetBitmap
      )
    $targetGraphics.InterpolationMode =
      [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $targetGraphics.PixelOffsetMode =
      [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $targetGraphics.DrawImage(
      $sourceBitmap,
      0,
      0,
      $targetWidth,
      $targetHeight
    )
  } else {
    $targetBitmap = $sourceBitmap
  }

  $stream =
    New-Object System.IO.MemoryStream
  $targetBitmap.Save(
    $stream,
    [System.Drawing.Imaging.ImageFormat]::Png
  )
  $bytes = $stream.ToArray()

  if ($bytes.LongLength -gt $maxBytes) {
    [pscustomobject]@{
      ok = $false
      code = 'PRIVATE_SCREEN_TOO_LARGE'
      message =
        'Encoded private-screen PNG exceeds max_bytes.'
      bytes = $bytes.LongLength
      maxBytes = $maxBytes
    } | ConvertTo-Json -Compress
    exit 6
  }

  $after =
    [NxPrivateScreenNative]::InputDesktop()

  [pscustomobject]@{
    ok = $true
    source = $source
    topologyKind = 'host_shared_native'
    perMonitorDpiAwarenessApplied = $dpiAwarenessApplied
    monitorCount = $displays.Count
    monitors = @($displays)
    selectedMonitorIndex = $(if($null -ne $selectedMonitor){[int]$selectedMonitor.index}else{$null})
    captureBounds = $(if($source -ne 'window'){
      [pscustomobject]@{x=$bounds.X;y=$bounds.Y;width=$bounds.Width;height=$bounds.Height}
    }else{$null})
    hwnd = $resolvedHwnd
    title = $windowTitle
    width = $targetWidth
    height = $targetHeight
    sourceWidth = $sourceWidth
    sourceHeight = $sourceHeight
    scaled = ($scale -lt 0.999999)
    scale = $scale
    mimeType = 'image/png'
    bytes = $bytes.LongLength
    base64 =
      [Convert]::ToBase64String($bytes)
    inputDesktopBefore = $before
    inputDesktopAfter = $after
    visibleDesktopChanged = ($before -ne $after)
    enumeratedWindows = $windows.Count
    capturedWindows = $captured
    failedWindows = $failed
  } | ConvertTo-Json -Depth 5 -Compress
} finally {
  if ($targetGraphics) {
    $targetGraphics.Dispose()
  }
  if (
    $targetBitmap -and
    $targetBitmap -ne $sourceBitmap
  ) {
    $targetBitmap.Dispose()
  }
  if ($sourceBitmap) {
    $sourceBitmap.Dispose()
  }
  if ($stream) {
    $stream.Dispose()
  }
}
`;

export interface WindowsPrivateScreenCapture {
  source: 'desktop' | 'monitor' | 'window';
  topologyKind: 'host_shared_native';
  perMonitorDpiAwarenessApplied: boolean;
  monitorCount: number;
  monitors: Array<{
    index: number; id: string; x: number; y: number;
    width: number; height: number; primary: boolean;
    effectiveDpiX: number | null; effectiveDpiY: number | null;
  }>;
  selectedMonitorIndex: number | null;
  captureBounds: {x:number;y:number;width:number;height:number} | null;
  hwnd: string | null;
  title: string | null;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  scaled: boolean;
  scale: number;
  mimeType: 'image/png';
  bytes: number;
  base64: string;
  inputDesktopBefore: string;
  inputDesktopAfter: string;
  visibleDesktopChanged: boolean;
  enumeratedWindows: number;
  capturedWindows: number;
  failedWindows: number;
}

async function invokeCapture(
  input: z.infer<typeof PrivateScreenSchema> | { source:'topology' },
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        captureScript,
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          NEXOWIRE_PRIVATE_SCREEN_INPUT:
            JSON.stringify(input),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (
      target: Buffer[],
      chunk: Buffer,
    ) => {
      bytes += chunk.length;
      if (bytes <= 16 * 1024 * 1024) {
        target.push(chunk);
      }
    };

    child.stdout.on(
      'data',
      (chunk: Buffer) =>
        collect(stdout, chunk),
    );
    child.stderr.on(
      'data',
      (chunk: Buffer) =>
        collect(stderr, chunk),
    );

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best effort.
      }
      reject(
        new PrivateScreenError(
          'PRIVATE_SCREEN_TIMEOUT',
          'Private-screen capture timed out.',
        ),
      );
    }, 30_000);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(
        new PrivateScreenError(
          'PRIVATE_SCREEN_START_FAILED',
          'Could not start the private-screen capture helper.',
          { nativeMessage: error.message },
        ),
      );
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout)
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trim();
      const err = Buffer.concat(stderr)
        .toString('utf8')
        .trim();

      let parsed: unknown;
      try {
        parsed = out ? JSON.parse(out) : {};
      } catch {
        reject(
          new PrivateScreenError(
            'PRIVATE_SCREEN_OUTPUT_INVALID',
            'Private-screen helper returned invalid JSON.',
            {
              outputPreview: out.slice(0, 2048),
              stderrPreview: err.slice(0, 2048),
            },
          ),
        );
        return;
      }

      if (code !== 0) {
        const failure = z
          .object({
            code: z.string().min(1).max(128),
            message: z.string().min(1).max(4096),
          })
          .safeParse(parsed);
        reject(
          new PrivateScreenError(
            failure.success
              ? failure.data.code
              : 'PRIVATE_SCREEN_FAILED',
            failure.success
              ? failure.data.message
              : err ||
                  'Private-screen capture failed.',
          ),
        );
        return;
      }

      resolve(parsed);
    });
  });
}

const TopologyMonitorSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string().min(1).max(128),
  x: z.number().int(), y: z.number().int(),
  width: z.number().int().positive(), height: z.number().int().positive(),
  primary: z.boolean(),
  effectiveDpiX: z.number().int().positive().nullable(),
  effectiveDpiY: z.number().int().positive().nullable(),
});

export const PrivateDisplayTopologyResultSchema = z.object({
  ok: z.literal(true),
  topologyKind: z.literal('host_shared_native'),
  independentAiDisplays: z.literal(false),
  monitorCount: z.number().int().nonnegative(),
  monitors: z.array(TopologyMonitorSchema),
  virtualBounds: z.object({
    x:z.number().int(),y:z.number().int(),
    width:z.number().int().positive(),height:z.number().int().positive(),
  }),
  perMonitorDpiAwarenessApplied: z.boolean(),
  capturedAt: z.string().datetime({offset:true}),
  inputDesktopBefore: z.string(),
  inputDesktopAfter: z.string(),
  visibleDesktopChanged: z.boolean(),
}).superRefine((value,ctx)=>{
  if(value.monitors.length!==value.monitorCount){
    ctx.addIssue({code:'custom',path:['monitorCount'],
      message:'Monitor count and inventory length do not match.'});
  }
  if(value.monitorCount<1){
    ctx.addIssue({code:'custom',path:['monitorCount'],
      message:'No connected monitor inventory reported.'});
  }
  if(value.monitors.length>0){
    const left=Math.min(...value.monitors.map(m=>m.x));
    const top=Math.min(...value.monitors.map(m=>m.y));
    const right=Math.max(...value.monitors.map(m=>m.x+m.width));
    const bottom=Math.max(...value.monitors.map(m=>m.y+m.height));
    const bounds=value.virtualBounds;
    if(bounds.x!==left||bounds.y!==top||
      bounds.width!==right-left||bounds.height!==bottom-top){
      ctx.addIssue({code:'custom',path:['virtualBounds'],
        message:'Reported virtual desktop bounds do not cover all monitors.'});
    }
    if(value.monitors.filter(m=>m.primary).length!==1){
      ctx.addIssue({code:'custom',path:['monitors'],
        message:'Exactly one primary host monitor must be identified.'});
    }
  }
  const ids=new Set<string>();
  for(let i=0;i<value.monitors.length;i++){
    const monitor=value.monitors[i]!;
    if(monitor.index!==i || ids.has(monitor.id.toUpperCase())){
      ctx.addIssue({code:'custom',path:['monitors',i],
        message:'Monitor indexes must be contiguous and IDs unique.'});
    }
    ids.add(monitor.id.toUpperCase());
  }
  if(value.visibleDesktopChanged ||
    value.inputDesktopBefore!==value.inputDesktopAfter){
    ctx.addIssue({code:'custom',path:['visibleDesktopChanged'],
      message:'Input desktop must be preserved during topology inspection.'});
  }
});

export type WindowsPrivateDisplayTopology =
  Omit<z.infer<typeof PrivateDisplayTopologyResultSchema>,'ok'>;

/**
 * Read host-shared monitor configuration without needing a screenshot or
 * launching a private app. This never provisions an independent AI monitor.
 */
export async function inspectWindowsPrivateDisplayTopology():Promise<{data:WindowsPrivateDisplayTopology}>{
  assertWindows();
  const parsed=PrivateDisplayTopologyResultSchema.parse(
    await invokeCapture({source:'topology'}),
  );
  const {ok:_ok,...data}=parsed;
  return {data};
}

export async function captureWindowsPrivateScreen(
  input: unknown,
): Promise<{
  data: WindowsPrivateScreenCapture;
}> {
  assertWindows();
  const parsed = parseWindowsPrivateScreenCaptureRequest(input);

  const result = z
    .object({
      ok: z.literal(true),
      source: z.enum(['desktop', 'monitor', 'window']),
      topologyKind: z.literal('host_shared_native'),
      perMonitorDpiAwarenessApplied: z.boolean(),
      monitorCount: z.number().int().nonnegative(),
      monitors: z.array(z.object({
        index:z.number().int().nonnegative(),
        id:z.string().min(1),x:z.number().int(),y:z.number().int(),
        width:z.number().int().positive(),height:z.number().int().positive(),
        primary:z.boolean(),
        effectiveDpiX:z.number().int().positive().nullable(),
        effectiveDpiY:z.number().int().positive().nullable(),
      })),
      selectedMonitorIndex:z.number().int().nonnegative().nullable(),
      captureBounds:z.object({
        x:z.number().int(),y:z.number().int(),
        width:z.number().int().positive(),height:z.number().int().positive(),
      }).nullable(),
      hwnd: z.string().nullable(),
      title: z.string().nullable(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      sourceWidth: z.number().int().positive(),
      sourceHeight: z.number().int().positive(),
      scaled: z.boolean(),
      scale: z.number().positive().max(1),
      mimeType: z.literal('image/png'),
      bytes: z.number().int().positive(),
      base64: z.string().min(1),
      inputDesktopBefore: z.string(),
      inputDesktopAfter: z.string(),
      visibleDesktopChanged: z.boolean(),
      enumeratedWindows: z
        .number()
        .int()
        .nonnegative(),
      capturedWindows: z
        .number()
        .int()
        .positive(),
      failedWindows: z
        .number()
        .int()
        .nonnegative(),
    })
    .parse(
      await invokeCapture(parsed),
    );

  const decoded = Buffer.from(
    result.base64,
    'base64',
  );
  if (
    decoded.length !== result.bytes ||
    decoded.length > parsed.max_bytes
  ) {
    throw new PrivateScreenError(
      'PRIVATE_SCREEN_SIZE_MISMATCH',
      'Private-screen PNG byte length failed verification.',
    );
  }
  if (
    decoded.length < 8 ||
    decoded[0] !== 0x89 ||
    decoded[1] !== 0x50 ||
    decoded[2] !== 0x4e ||
    decoded[3] !== 0x47
  ) {
    throw new PrivateScreenError(
      'PRIVATE_SCREEN_INVALID_PNG',
      'Private-screen helper returned a non-PNG payload.',
    );
  }
  if (result.visibleDesktopChanged) {
    throw new PrivateScreenError(
      'PRIVATE_SCREEN_CHANGED_INPUT_DESKTOP',
      'Private-screen capture changed the visible Windows input desktop.',
      {
        inputDesktopBefore:
          result.inputDesktopBefore,
        inputDesktopAfter:
          result.inputDesktopAfter,
      },
    );
  }

  return {
    data: result,
  };
}
