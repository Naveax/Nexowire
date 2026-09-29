import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as z from 'zod';

const ScreenshotInputSchema = z
  .object({
    source: z
      .enum(['virtual_desktop', 'primary_screen', 'window'])
      .default('virtual_desktop'),
    hwnd: z
      .string()
      .min(1)
      .max(32)
      .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/)
      .optional(),
    max_width: z.number().int().min(160).max(7680).default(2560),
    max_height: z.number().int().min(120).max(4320).default(1440),
    max_bytes: z
      .number()
      .int()
      .min(65_536)
      .max(8_388_608)
      .default(8_388_608),
  })
  .superRefine((value, ctx) => {
    if (value.source === 'window' && !value.hwnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hwnd'],
        message: 'hwnd is required when source=window.',
      });
    }
    if (value.source !== 'window' && value.hwnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hwnd'],
        message: 'hwnd is only valid when source=window.',
      });
    }
  });

class ScreenshotError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ScreenshotError';
  }
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new ScreenshotError(
      'WINDOWS_REQUIRED',
      'Screenshot capture requires a Windows native agent.',
    );
  }
}

const screenshotScript = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('NexowireScreenshotNative' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NexowireScreenshotNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetProcessDPIAware();
}
"@
}

[void][NexowireScreenshotNative]::SetProcessDPIAware()
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$source = [string]$inputData.source
$maxWidth = [int]$inputData.max_width
$maxHeight = [int]$inputData.max_height
$maxBytes = [int64]$inputData.max_bytes

$sourceX = 0
$sourceY = 0
$sourceWidth = 0
$sourceHeight = 0
$resolvedHwnd = $null
$windowVisible = $null

if ($source -eq 'virtual_desktop') {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $sourceX = $bounds.X
  $sourceY = $bounds.Y
  $sourceWidth = $bounds.Width
  $sourceHeight = $bounds.Height
} elseif ($source -eq 'primary_screen') {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $sourceX = $bounds.X
  $sourceY = $bounds.Y
  $sourceWidth = $bounds.Width
  $sourceHeight = $bounds.Height
} elseif ($source -eq 'window') {
  $raw = [string]$inputData.hwnd
  $value = if (
    $raw.StartsWith('0x', [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    [Convert]::ToInt64($raw.Substring(2), 16)
  } else {
    [Convert]::ToInt64($raw, 10)
  }
  $hWnd = [IntPtr]::new($value)
  if (-not [NexowireScreenshotNative]::IsWindow($hWnd)) {
    [pscustomobject]@{
      ok = $false
      code = 'WINDOW_NOT_FOUND'
      message = 'The requested HWND does not identify a current window.'
      hwnd = $raw
    } | ConvertTo-Json -Compress
    exit 3
  }
  $rect = New-Object NexowireScreenshotNative+RECT
  if (-not [NexowireScreenshotNative]::GetWindowRect($hWnd, [ref]$rect)) {
    [pscustomobject]@{
      ok = $false
      code = 'WINDOW_RECT_UNAVAILABLE'
      message = 'Windows did not return a rectangle for the requested HWND.'
      hwnd = $raw
    } | ConvertTo-Json -Compress
    exit 4
  }

  $sourceX = $rect.Left
  $sourceY = $rect.Top
  $sourceWidth = $rect.Right - $rect.Left
  $sourceHeight = $rect.Bottom - $rect.Top
  $resolvedHwnd = ('0x{0:X}' -f $hWnd.ToInt64())
  $windowVisible = [NexowireScreenshotNative]::IsWindowVisible($hWnd)
} else {
  throw 'Unsupported screenshot source.'
}

if ($sourceWidth -le 0 -or $sourceHeight -le 0) {
  [pscustomobject]@{
    ok = $false
    code = 'SCREENSHOT_EMPTY_RECT'
    message = 'The selected screenshot rectangle has no drawable area.'
    source = $source
    hwnd = $resolvedHwnd
    width = $sourceWidth
    height = $sourceHeight
  } | ConvertTo-Json -Compress
  exit 5
}

$scale = [Math]::Min(
  1.0,
  [Math]::Min(
    $maxWidth / [double]$sourceWidth,
    $maxHeight / [double]$sourceHeight
  )
)
$targetWidth = [Math]::Max(1, [int][Math]::Round($sourceWidth * $scale))
$targetHeight = [Math]::Max(1, [int][Math]::Round($sourceHeight * $scale))

$sourceBitmap = $null
$targetBitmap = $null
$graphics = $null
$targetGraphics = $null
$stream = $null

try {
  $sourceBitmap = New-Object System.Drawing.Bitmap(
    $sourceWidth,
    $sourceHeight,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $graphics = [System.Drawing.Graphics]::FromImage($sourceBitmap)
  try {
    $graphics.CopyFromScreen(
      $sourceX,
      $sourceY,
      0,
      0,
      $sourceBitmap.Size,
      [System.Drawing.CopyPixelOperation]::SourceCopy
    )
  } catch {
    [pscustomobject]@{
      ok = $false
      code = 'SCREENSHOT_DESKTOP_UNAVAILABLE'
      message = 'The agent session cannot capture the interactive desktop.'
      source = $source
      hwnd = $resolvedHwnd
      nativeMessage = $_.Exception.Message
    } | ConvertTo-Json -Compress
    exit 7
  }

  if (
    $targetWidth -ne $sourceWidth -or
    $targetHeight -ne $sourceHeight
  ) {
    $targetBitmap = New-Object System.Drawing.Bitmap(
      $targetWidth,
      $targetHeight,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $targetGraphics = [System.Drawing.Graphics]::FromImage($targetBitmap)
    $targetGraphics.CompositingMode =
      [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $targetGraphics.CompositingQuality =
      [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $targetGraphics.InterpolationMode =
      [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $targetGraphics.SmoothingMode =
      [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
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

  $stream = New-Object System.IO.MemoryStream
  $targetBitmap.Save(
    $stream,
    [System.Drawing.Imaging.ImageFormat]::Png
  )
  $bytes = $stream.ToArray()

  if ($bytes.LongLength -gt $maxBytes) {
    [pscustomobject]@{
      ok = $false
      code = 'SCREENSHOT_TOO_LARGE'
      message = 'Encoded PNG exceeds max_bytes. Lower max_width/max_height.'
      bytes = $bytes.LongLength
      maxBytes = $maxBytes
      width = $targetWidth
      height = $targetHeight
    } | ConvertTo-Json -Compress
    exit 6
  }

  [pscustomobject]@{
    ok = $true
    source = $source
    hwnd = $resolvedHwnd
    windowVisible = $windowVisible
    captureRect = [pscustomobject]@{
      x = $sourceX
      y = $sourceY
      width = $sourceWidth
      height = $sourceHeight
    }
    width = $targetWidth
    height = $targetHeight
    scaled = ($scale -lt 0.999999)
    scale = $scale
    mimeType = 'image/png'
    bytes = $bytes.LongLength
    base64 = [Convert]::ToBase64String($bytes)
  } | ConvertTo-Json -Depth 6 -Compress
} finally {
  if ($targetGraphics) { $targetGraphics.Dispose() }
  if ($graphics) { $graphics.Dispose() }
  if ($stream) { $stream.Dispose() }
  if ($targetBitmap -and $targetBitmap -ne $sourceBitmap) {
    $targetBitmap.Dispose()
  }
  if ($sourceBitmap) { $sourceBitmap.Dispose() }
}
`;

async function runPowerShellJson<T>(
  script: string,
  input: unknown,
  timeoutMs = 45_000,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        env: {
          ...process.env,
          NEXOWIRE_INPUT: JSON.stringify(input),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
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
          new ScreenshotError(
            'SCREENSHOT_TIMEOUT',
            'Screenshot capture timed out after ' + timeoutMs + 'ms.',
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
            reject(new ScreenshotError(code, message, details));
            return;
          }
        } catch {
          // Fall through to the generic PowerShell error.
        }

        reject(
          new ScreenshotError(
            'SCREENSHOT_CAPTURE_FAILED',
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
          new ScreenshotError(
            'SCREENSHOT_INVALID_RESPONSE',
            'Screenshot capture returned invalid JSON.',
            { stdout: out.slice(0, 1000) },
          ),
        );
      }
    });
  });
}

export interface WindowsScreenshotData {
  source: 'virtual_desktop' | 'primary_screen' | 'window';
  hwnd: string | null;
  windowVisible: boolean | null;
  captureRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  width: number;
  height: number;
  scaled: boolean;
  scale: number;
  mimeType: 'image/png';
  bytes: number;
  sha256: string;
  base64: string;
  capturedAt: string;
}

export async function captureWindowsScreenshot(
  input: unknown,
): Promise<{ data: WindowsScreenshotData }> {
  assertWindows();
  const parsed = ScreenshotInputSchema.parse(input);
  const raw = await runPowerShellJson<
    Omit<WindowsScreenshotData, 'sha256' | 'capturedAt'>
  >(screenshotScript, parsed);

  const bytes = Buffer.from(raw.base64, 'base64');
  if (bytes.length !== raw.bytes) {
    throw new ScreenshotError(
      'SCREENSHOT_SIZE_MISMATCH',
      'Screenshot byte length did not match the capture metadata.',
      { expected: raw.bytes, actual: bytes.length },
    );
  }

  if (bytes.length > parsed.max_bytes) {
    throw new ScreenshotError(
      'SCREENSHOT_TOO_LARGE',
      'Screenshot exceeded max_bytes after capture.',
      { bytes: bytes.length, maxBytes: parsed.max_bytes },
    );
  }

  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (bytes.length < pngSignature.length ||
      !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new ScreenshotError(
      'SCREENSHOT_INVALID_PNG',
      'Screenshot payload is not a valid PNG stream.',
    );
  }

  return {
    data: {
      ...raw,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      capturedAt: new Date().toISOString(),
    },
  };
}
