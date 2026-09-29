import { spawn } from 'node:child_process';
import * as z from 'zod';

const WindowHandleSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/);

const CoordinateModeSchema = z
  .enum(['client_pixels', 'normalized'])
  .default('client_pixels');

const PointerPointSchema = z
  .object({
    hwnd: WindowHandleSchema,
    coordinate_mode: CoordinateModeSchema,
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .superRefine((value, ctx) => {
    if (value.coordinate_mode === 'client_pixels') {
      if (!Number.isInteger(value.x) || !Number.isInteger(value.y)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['x'],
          message:
            'client_pixels coordinates must be integer pixel positions.',
        });
      }
      return;
    }

    if (
      value.x < 0 ||
      value.x > 1 ||
      value.y < 0 ||
      value.y > 1
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['x'],
        message:
          'normalized coordinates must both be between 0 and 1.',
      });
    }
  });

const PointerPositionInputSchema = z.object({
  hwnd: WindowHandleSchema.optional(),
});

const PointerMoveInputSchema = PointerPointSchema;

const PointerClickInputSchema = PointerPointSchema.extend({
  button: z.enum(['left', 'right', 'middle']).default('left'),
  count: z.number().int().min(1).max(3).default(1),
  interval_ms: z.number().int().min(20).max(1000).default(100),
});

const PointerScrollInputSchema = PointerPointSchema.extend({
  delta: z.number().int().min(-12_000).max(12_000).refine(
    (value) => value !== 0,
    { message: 'scroll delta must not be zero.' },
  ),
  horizontal: z.boolean().default(false),
});

class WindowsPointerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WindowsPointerError';
  }
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new WindowsPointerError(
      'WINDOWS_REQUIRED',
      'Windows pointer control requires a Windows native agent.',
    );
  }
}

const pointerScript = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

if (-not ('NexowirePointerNative' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class NexowirePointerNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg;
    public ushort wParamL;
    public ushort wParamH;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }

  public const uint INPUT_MOUSE = 0;
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008;
  public const uint RIGHTUP = 0x0010;
  public const uint MIDDLEDOWN = 0x0020;
  public const uint MIDDLEUP = 0x0040;
  public const uint WHEEL = 0x0800;
  public const uint HWHEEL = 0x1000;
  public const uint GA_ROOT = 2;

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetProcessDPIAware();

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetCursorPos(out POINT lpPoint);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT point);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(
    uint nInputs,
    INPUT[] pInputs,
    int cbSize
  );

  private static void SendMouse(uint flags, int data) {
    var input = new INPUT {
      type = INPUT_MOUSE,
      U = new InputUnion {
        mi = new MOUSEINPUT {
          dx = 0,
          dy = 0,
          mouseData = unchecked((uint)data),
          dwFlags = flags,
          time = 0,
          dwExtraInfo = UIntPtr.Zero
        }
      }
    };
    var sent = SendInput(
      1,
      new [] { input },
      Marshal.SizeOf(typeof(INPUT))
    );
    if (sent != 1) {
      throw new Win32Exception(
        Marshal.GetLastWin32Error(),
        "SendInput mouse operation failed."
      );
    }
  }

  public static void Click(string button, int count, int intervalMs) {
    uint down;
    uint up;
    switch (button) {
      case "left":
        down = LEFTDOWN;
        up = LEFTUP;
        break;
      case "right":
        down = RIGHTDOWN;
        up = RIGHTUP;
        break;
      case "middle":
        down = MIDDLEDOWN;
        up = MIDDLEUP;
        break;
      default:
        throw new ArgumentOutOfRangeException("button");
    }

    for (var i = 0; i < count; i++) {
      SendMouse(down, 0);
      SendMouse(up, 0);
      if (i + 1 < count && intervalMs > 0) {
        Thread.Sleep(intervalMs);
      }
    }
  }

  public static void Scroll(int delta, bool horizontal) {
    SendMouse(horizontal ? HWHEEL : WHEEL, delta);
  }
}
"@
}

[void][NexowirePointerNative]::SetProcessDPIAware()
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$operation = [string]$inputData.operation

function Convert-Hwnd {
  param([string]$Raw)
  $value = if (
    $Raw.StartsWith('0x', [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    [Convert]::ToInt64($Raw.Substring(2), 16)
  } else {
    [Convert]::ToInt64($Raw, 10)
  }
  return [IntPtr]::new($value)
}

function Format-Hwnd {
  param([IntPtr]$Handle)
  if ($Handle -eq [IntPtr]::Zero) {
    return $null
  }
  return ('0x{0:X}' -f $Handle.ToInt64())
}

function Get-TargetContext {
  param(
    [string]$RawHwnd,
    [string]$CoordinateMode,
    [double]$X,
    [double]$Y,
    [bool]$RequireForeground
  )

  $hWnd = Convert-Hwnd $RawHwnd
  if (-not [NexowirePointerNative]::IsWindow($hWnd)) {
    [pscustomobject]@{
      ok = $false
      code = 'WINDOW_NOT_FOUND'
      message = 'The requested HWND does not identify a current window.'
      hwnd = $RawHwnd
    } | ConvertTo-Json -Compress
    exit 3
  }

  $targetRoot = [NexowirePointerNative]::GetAncestor(
    $hWnd,
    [NexowirePointerNative]::GA_ROOT
  )
  if ($targetRoot -eq [IntPtr]::Zero) {
    $targetRoot = $hWnd
  }

  $foreground = [NexowirePointerNative]::GetForegroundWindow()
  $foregroundRoot = if ($foreground -eq [IntPtr]::Zero) {
    [IntPtr]::Zero
  } else {
    [NexowirePointerNative]::GetAncestor(
      $foreground,
      [NexowirePointerNative]::GA_ROOT
    )
  }

  if (
    $RequireForeground -and
    $foregroundRoot -ne $targetRoot
  ) {
    [pscustomobject]@{
      ok = $false
      code = 'WINDOW_NOT_FOREGROUND'
      message = 'Pointer mutation is refused because the requested HWND is not the current foreground top-level window.'
      hwnd = Format-Hwnd $hWnd
      foregroundHwnd = Format-Hwnd $foreground
      foregroundRootHwnd = Format-Hwnd $foregroundRoot
    } | ConvertTo-Json -Compress
    exit 9
  }

  $rect = New-Object NexowirePointerNative+RECT
  if (-not [NexowirePointerNative]::GetClientRect($hWnd, [ref]$rect)) {
    [pscustomobject]@{
      ok = $false
      code = 'WINDOW_CLIENT_RECT_UNAVAILABLE'
      message = 'Windows did not return a client rectangle for the requested HWND.'
      hwnd = Format-Hwnd $hWnd
    } | ConvertTo-Json -Compress
    exit 20
  }

  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) {
    [pscustomobject]@{
      ok = $false
      code = 'WINDOW_CLIENT_RECT_EMPTY'
      message = 'The requested HWND has no drawable client area.'
      hwnd = Format-Hwnd $hWnd
      width = $width
      height = $height
    } | ConvertTo-Json -Compress
    exit 21
  }

  if ($CoordinateMode -eq 'normalized') {
    $clientX = [int][Math]::Round(
      [Math]::Min($width - 1, [Math]::Max(0, $X * ($width - 1)))
    )
    $clientY = [int][Math]::Round(
      [Math]::Min($height - 1, [Math]::Max(0, $Y * ($height - 1)))
    )
  } else {
    $clientX = [int]$X
    $clientY = [int]$Y
  }

  if (
    $clientX -lt 0 -or
    $clientY -lt 0 -or
    $clientX -ge $width -or
    $clientY -ge $height
  ) {
    [pscustomobject]@{
      ok = $false
      code = 'POINTER_OUTSIDE_CLIENT'
      message = 'Requested pointer coordinates are outside the HWND client rectangle.'
      hwnd = Format-Hwnd $hWnd
      clientPoint = [pscustomobject]@{
        x = $clientX
        y = $clientY
      }
      clientSize = [pscustomobject]@{
        width = $width
        height = $height
      }
    } | ConvertTo-Json -Depth 5 -Compress
    exit 22
  }

  $point = New-Object NexowirePointerNative+POINT
  $point.X = $clientX
  $point.Y = $clientY
  if (-not [NexowirePointerNative]::ClientToScreen($hWnd, [ref]$point)) {
    [pscustomobject]@{
      ok = $false
      code = 'POINTER_COORDINATE_CONVERSION_FAILED'
      message = 'ClientToScreen failed for the requested HWND coordinates.'
      hwnd = Format-Hwnd $hWnd
    } | ConvertTo-Json -Compress
    exit 23
  }

  return [pscustomobject]@{
    hwnd = $hWnd
    targetRoot = $targetRoot
    foreground = $foreground
    foregroundRoot = $foregroundRoot
    clientX = $clientX
    clientY = $clientY
    clientWidth = $width
    clientHeight = $height
    screenX = $point.X
    screenY = $point.Y
  }
}

function Test-HitTarget {
  param(
    [IntPtr]$TargetRoot,
    [int]$ScreenX,
    [int]$ScreenY
  )
  $point = New-Object NexowirePointerNative+POINT
  $point.X = $ScreenX
  $point.Y = $ScreenY
  $hit = [NexowirePointerNative]::WindowFromPoint($point)
  $hitRoot = if ($hit -eq [IntPtr]::Zero) {
    [IntPtr]::Zero
  } else {
    [NexowirePointerNative]::GetAncestor(
      $hit,
      [NexowirePointerNative]::GA_ROOT
    )
  }

  return [pscustomobject]@{
    hit = $hit
    hitRoot = $hitRoot
    verified = ($hitRoot -eq $TargetRoot)
  }
}

if ($operation -eq 'position') {
  $cursor = New-Object NexowirePointerNative+POINT
  if (-not [NexowirePointerNative]::GetCursorPos([ref]$cursor)) {
    throw 'GetCursorPos failed.'
  }

  $result = [ordered]@{
    screenPoint = [pscustomobject]@{
      x = $cursor.X
      y = $cursor.Y
    }
  }

  if ($null -ne $inputData.hwnd) {
    $hWnd = Convert-Hwnd ([string]$inputData.hwnd)
    if (-not [NexowirePointerNative]::IsWindow($hWnd)) {
      [pscustomobject]@{
        ok = $false
        code = 'WINDOW_NOT_FOUND'
        message = 'The requested HWND does not identify a current window.'
        hwnd = [string]$inputData.hwnd
      } | ConvertTo-Json -Compress
      exit 3
    }

    $rect = New-Object NexowirePointerNative+RECT
    if (-not [NexowirePointerNative]::GetClientRect($hWnd, [ref]$rect)) {
      throw 'GetClientRect failed.'
    }

    $client = New-Object NexowirePointerNative+POINT
    $client.X = $cursor.X
    $client.Y = $cursor.Y
    if (-not [NexowirePointerNative]::ScreenToClient($hWnd, [ref]$client)) {
      throw 'ScreenToClient failed.'
    }

    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    $origin = New-Object NexowirePointerNative+POINT
    $origin.X = 0
    $origin.Y = 0
    if (-not [NexowirePointerNative]::ClientToScreen($hWnd, [ref]$origin)) {
      throw 'ClientToScreen origin conversion failed.'
    }
    $result.hwnd = Format-Hwnd $hWnd
    $result.clientPoint = [pscustomobject]@{
      x = $client.X
      y = $client.Y
    }
    $result.clientOriginScreen = [pscustomobject]@{
      x = $origin.X
      y = $origin.Y
    }
    $result.clientSize = [pscustomobject]@{
      width = $width
      height = $height
    }
    $result.insideClient = (
      $client.X -ge 0 -and
      $client.Y -ge 0 -and
      $client.X -lt $width -and
      $client.Y -lt $height
    )
  }

  [pscustomobject]$result | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

$context = Get-TargetContext -RawHwnd ([string]$inputData.hwnd) -CoordinateMode ([string]$inputData.coordinate_mode) -X ([double]$inputData.x) -Y ([double]$inputData.y) -RequireForeground $true

$hitBefore = Test-HitTarget -TargetRoot $context.targetRoot -ScreenX $context.screenX -ScreenY $context.screenY

if (-not $hitBefore.verified) {
  [pscustomobject]@{
    ok = $false
    code = 'POINTER_TARGET_OCCLUDED'
    message = 'The requested client point is not currently hittable inside the target top-level window.'
    hwnd = Format-Hwnd $context.hwnd
    hitHwnd = Format-Hwnd $hitBefore.hit
    hitRootHwnd = Format-Hwnd $hitBefore.hitRoot
    screenPoint = [pscustomobject]@{
      x = $context.screenX
      y = $context.screenY
    }
  } | ConvertTo-Json -Depth 5 -Compress
  exit 24
}

if (
  -not [NexowirePointerNative]::SetCursorPos(
    $context.screenX,
    $context.screenY
  )
) {
  throw 'SetCursorPos failed.'
}

$cursor = New-Object NexowirePointerNative+POINT
if (-not [NexowirePointerNative]::GetCursorPos([ref]$cursor)) {
  throw 'GetCursorPos verification failed.'
}
$cursorVerified = (
  [Math]::Abs($cursor.X - $context.screenX) -le 1 -and
  [Math]::Abs($cursor.Y - $context.screenY) -le 1
)
if (-not $cursorVerified) {
  [pscustomobject]@{
    ok = $false
    code = 'POINTER_MOVE_NOT_VERIFIED'
    message = 'Windows did not place the pointer at the requested point.'
    requested = [pscustomobject]@{
      x = $context.screenX
      y = $context.screenY
    }
    actual = [pscustomobject]@{
      x = $cursor.X
      y = $cursor.Y
    }
  } | ConvertTo-Json -Depth 5 -Compress
  exit 25
}

if ($operation -eq 'move') {
  [pscustomobject]@{
    ok = $true
    hwnd = Format-Hwnd $context.hwnd
    coordinateMode = [string]$inputData.coordinate_mode
    clientPoint = [pscustomobject]@{
      x = $context.clientX
      y = $context.clientY
    }
    clientSize = [pscustomobject]@{
      width = $context.clientWidth
      height = $context.clientHeight
    }
    screenPoint = [pscustomobject]@{
      x = $context.screenX
      y = $context.screenY
    }
    cursorVerified = $true
    targetHitVerified = $true
  } | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

try {
  if ($operation -eq 'click') {
    [NexowirePointerNative]::Click(
      [string]$inputData.button,
      [int]$inputData.count,
      [int]$inputData.interval_ms
    )
  } elseif ($operation -eq 'scroll') {
    [NexowirePointerNative]::Scroll(
      [int]$inputData.delta,
      [bool]$inputData.horizontal
    )
  } else {
    throw 'Unsupported pointer operation.'
  }
} catch {
  [pscustomobject]@{
    ok = $false
    code = 'POINTER_INPUT_FAILED'
    message = 'Windows pointer input injection failed.'
    nativeMessage = $_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 26
}

Start-Sleep -Milliseconds 50
$foregroundAfter = [NexowirePointerNative]::GetForegroundWindow()
$foregroundRootAfter = if ($foregroundAfter -eq [IntPtr]::Zero) {
  [IntPtr]::Zero
} else {
  [NexowirePointerNative]::GetAncestor(
    $foregroundAfter,
    [NexowirePointerNative]::GA_ROOT
  )
}
$foregroundVerifiedAfter = (
  $foregroundRootAfter -eq $context.targetRoot
)

[pscustomobject]@{
  ok = $true
  hwnd = Format-Hwnd $context.hwnd
  operation = $operation
  coordinateMode = [string]$inputData.coordinate_mode
  clientPoint = [pscustomobject]@{
    x = $context.clientX
    y = $context.clientY
  }
  clientSize = [pscustomobject]@{
    width = $context.clientWidth
    height = $context.clientHeight
  }
  screenPoint = [pscustomobject]@{
    x = $context.screenX
    y = $context.screenY
  }
  cursorVerified = $true
  targetHitVerified = $true
  foregroundVerifiedAfter = $foregroundVerifiedAfter
  foregroundHwndAfter = Format-Hwnd $foregroundAfter
  button = if ($operation -eq 'click') {
    [string]$inputData.button
  } else {
    $null
  }
  count = if ($operation -eq 'click') {
    [int]$inputData.count
  } else {
    $null
  }
  delta = if ($operation -eq 'scroll') {
    [int]$inputData.delta
  } else {
    $null
  }
  horizontal = if ($operation -eq 'scroll') {
    [bool]$inputData.horizontal
  } else {
    $null
  }
} | ConvertTo-Json -Depth 6 -Compress
`;

async function runPowerShellJson<T>(
  input: unknown,
  timeoutMs = 45_000,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        pointerScript,
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', (exitCode) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const err = Buffer.concat(stderr).toString('utf8').trim();

      if (timedOut) {
        reject(
          new WindowsPointerError(
            'POINTER_TIMEOUT',
            'Windows pointer operation timed out after ' +
              timeoutMs +
              'ms.',
          ),
        );
        return;
      }

      if (exitCode !== 0) {
        try {
          const parsed = JSON.parse(out) as {
            code?: string;
            message?: string;
            [key: string]: unknown;
          };
          if (parsed.code && parsed.message) {
            const { code, message, ...details } = parsed;
            reject(new WindowsPointerError(code, message, details));
            return;
          }
        } catch {
          // Fall through to generic PowerShell failure.
        }

        reject(
          new WindowsPointerError(
            'POINTER_FAILED',
            err ||
              out ||
              'PowerShell exited with code ' +
                (exitCode ?? 'unknown') +
                '.',
          ),
        );
        return;
      }

      try {
        resolve(JSON.parse(out) as T);
      } catch {
        reject(
          new WindowsPointerError(
            'POINTER_INVALID_RESPONSE',
            'Windows pointer operation returned invalid JSON.',
            { stdout: out.slice(0, 1500) },
          ),
        );
      }
    });

    child.stdin.end(JSON.stringify(input), 'utf8');
  });
}

async function pointerPosition(input: unknown) {
  assertWindows();
  const parsed = PointerPositionInputSchema.parse(input);
  return {
    data: await runPowerShellJson<Record<string, unknown>>({
      operation: 'position',
      ...parsed,
    }),
  };
}

async function pointerMove(input: unknown) {
  assertWindows();
  const parsed = PointerMoveInputSchema.parse(input);
  return {
    data: await runPowerShellJson<Record<string, unknown>>({
      operation: 'move',
      ...parsed,
    }),
  };
}

async function pointerClick(input: unknown) {
  assertWindows();
  const parsed = PointerClickInputSchema.parse(input);
  return {
    data: await runPowerShellJson<Record<string, unknown>>({
      operation: 'click',
      ...parsed,
    }),
  };
}

async function pointerScroll(input: unknown) {
  assertWindows();
  const parsed = PointerScrollInputSchema.parse(input);
  return {
    data: await runPowerShellJson<Record<string, unknown>>({
      operation: 'scroll',
      ...parsed,
    }),
  };
}

export async function executeWindowsPointerCapability(
  capability: string,
  input: unknown,
): Promise<unknown> {
  switch (capability) {
    case 'windows.pointer.position':
      return await pointerPosition(input);
    case 'windows.pointer.move':
      return await pointerMove(input);
    case 'windows.pointer.click':
      return await pointerClick(input);
    case 'windows.pointer.scroll':
      return await pointerScroll(input);
    default:
      throw new WindowsPointerError(
        'POINTER_UNSUPPORTED',
        'Unsupported Windows pointer capability: ' + capability,
      );
  }
}
